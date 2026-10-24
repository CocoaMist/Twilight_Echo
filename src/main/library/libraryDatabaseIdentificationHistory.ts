import type { DatabaseSync } from 'node:sqlite'
import type { CatalogKind } from '../../shared/musicCatalog.ts'
import type { MusicRatingImpact } from '../../shared/musicRatings.ts'
import type { MusicPreferenceImpact } from '../../shared/musicPreferences.ts'
import {
  validIdentificationPayload,
  validMusicExternalReference,
  type IdentificationCandidate,
  type IdentificationHistoryItem,
  type IdentificationHistoryPage,
  type IdentificationHistoryQuery,
  type IdentificationHistoryReview,
  type IdentificationInput,
  type IdentificationVerification,
  type IdentificationRestorePreview,
  type MusicExternalReference,
  type MusicIdentityDetail
} from '../../shared/musicIdentification.ts'

type Row = Record<string, unknown>
type Audit = IdentificationCandidate & {
  decision?: { mode: string; restoredFrom?: number }
}
export interface IdentificationHistoryOwner {
  sql: DatabaseSync
  detail(entityId: string): MusicIdentityDetail
  input(entityId: string): IdentificationInput
  references(targetId: string | null): MusicExternalReference[]
  currentMemberParent(
    parent: Extract<IdentificationVerification, { method: 'album_member' }>['parent']
  ): boolean
  preferenceImpact(entityId: string, kind: CatalogKind, targetId: string | null): MusicPreferenceImpact | undefined
  ratingImpact(entityId: string, kind: CatalogKind, targetId: string | null): MusicRatingImpact | undefined
}

/** Historical receipts remain immutable; they never become fresh candidates. */
export class LibraryDatabaseIdentificationHistory {
  private readonly owner: IdentificationHistoryOwner
  constructor(owner: IdentificationHistoryOwner) {
    this.owner = owner
  }
  private get sql() {
    return this.owner.sql
  }
  private active(entityId: string): boolean {
    return !!this.sql
      .prepare(
        `SELECT 1 FROM catalog_entity_sources b JOIN catalog_sources s ON s.id=b.source_id
      WHERE b.entity_id=? AND s.availability<>'missing'
      AND EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)
      AND (s.provider<>'local' OR (EXISTS(SELECT 1 FROM tracks t WHERE t.id=s.track_id)
        AND NOT EXISTS(SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id))) LIMIT 1`
      )
      .get(entityId)
  }
  private audit(row: Row): Audit | null {
    const audit = JSON.parse(String(row.evidence)) as Partial<Audit>
    return typeof audit.inputVersion === 'string' &&
      typeof audit.name === 'string' &&
      Array.isArray(audit.references) &&
      audit.references.length > 0 &&
      audit.references.length <= 16 &&
      audit.references.every(validMusicExternalReference) &&
      audit.evidence
      ? (audit as Audit)
      : null
  }
  private item(row: Row): IdentificationHistoryItem {
    // A replaced event contains the incoming candidate, not the outgoing IDs.
    const snapshot =
      row.state === 'detached' || row.state === 'replaced'
        ? this.sql
            .prepare(
              `SELECT * FROM metadata_identity_history WHERE link_id=? AND target_id=?
          AND state='confirmed' AND seq<=? ORDER BY seq DESC LIMIT 1`
            )
            .get(String(row.link_id), String(row.target_id), Number(row.seq))
        : row
    const audit = snapshot ? this.audit(snapshot) : null
    return {
      seq: Number(row.seq),
      state: row.state as IdentificationHistoryItem['state'],
      changedAt: Number(row.changed_at),
      targetId: row.target_id === null ? null : String(row.target_id),
      name: audit?.name ?? '',
      references: audit?.references ?? [],
      hasSnapshot: row.state === 'confirmed' && !!audit,
      restoredFrom: row.state === 'confirmed' ? (audit?.decision?.restoredFrom ?? null) : null
    }
  }
  page(query: IdentificationHistoryQuery): IdentificationHistoryPage {
    if (!validIdentificationPayload('identification.history', query))
      throw new Error('无效的身份历史查询')
    if (!this.active(query.entityId))
      throw Object.assign(new Error('此条目已不在可用音乐库中'), { code: 'STALE_REVISION' })
    const current = this.owner.detail(query.entityId),
      input = this.owner.input(query.entityId)
    const linkId = current.link?.id ?? ''
    return {
      entityId: query.entityId,
      inputVersion: input.version,
      current,
      offset: query.offset ?? 0,
      total: Number(
        this.sql
          .prepare('SELECT count(*) n FROM metadata_identity_history WHERE link_id=?')
          .get(linkId)!.n
      ),
      items: this.sql
        .prepare(
          `SELECT * FROM metadata_identity_history WHERE link_id=? ORDER BY seq DESC LIMIT ? OFFSET ?`
        )
        .all(linkId, query.limit ?? 20, query.offset ?? 0)
        .map((row) => this.item(row))
    }
  }
  receipt(request: IdentificationHistoryReview): { row: Row; audit: Audit | null } {
    if (!validIdentificationPayload('identification.restorePreview', request))
      throw new Error('无效的历史关联版本')
    const row = this.sql
      .prepare(
        `SELECT h.* FROM metadata_identity_history h
      JOIN metadata_identity_links l ON l.id=h.link_id WHERE h.seq=? AND l.entity_id=?`
      )
      .get(request.historySeq, request.entityId)
    if (!row) throw new Error('关联历史不存在')
    return { row, audit: this.audit(row) }
  }
  preview(request: IdentificationHistoryReview): IdentificationRestorePreview {
    const { row, audit } = this.receipt(request)
    const current = this.owner.detail(request.entityId),
      input = this.owner.input(request.entityId)
    const history = this.item(row),
      references = this.owner.references(history.targetId)
    const proof = audit?.evidence.verification
    const stale =
      !this.active(request.entityId) ||
      input.version !== request.inputVersion ||
      input.linkRevision !== request.linkRevision ||
      audit?.inputVersion !== input.version ||
      (proof?.method === 'album_member' && !this.owner.currentMemberParent(proof.parent))
    const conflicts: string[] = []
    if (
      row.state !== 'confirmed' ||
      !audit ||
      audit.entityId !== request.entityId ||
      audit.kind !== current.kind
    )
      conflicts.push('history_confirmation_snapshot_unavailable')
    if (
      !history.targetId ||
      !references.length ||
      references.some((ref) => ref.kind !== current.kind)
    )
      conflicts.push('history_target_unavailable')
    if (
      audit?.references.some(
        (ref) =>
          !references.some((currentRef) => JSON.stringify(currentRef) === JSON.stringify(ref))
      )
    )
      conflicts.push('history_references_changed')
    const namespaces = new Map<string, string>()
    for (const ref of references) {
      const key = JSON.stringify([ref.provider, ref.kind, ref.idType])
      if (
        namespaces.has(key) &&
        namespaces.get(key) !== ref.value &&
        !conflicts.includes('conflicting_ids_in_same_namespace')
      )
        conflicts.push('conflicting_ids_in_same_namespace')
      namespaces.set(key, ref.value)
    }
    const action =
      current.link?.state !== 'confirmed'
        ? 'link'
        : current.link.targetId === history.targetId
          ? 'keep'
          : 'replace'
    const ratingImpact = this.owner.ratingImpact(request.entityId, current.kind, history.targetId)
    const preferenceImpact = this.owner.preferenceImpact(request.entityId, current.kind, history.targetId)
    return {
      request: { ...request },
      history,
      current,
      references,
      action,
      stale,
      conflicts,
      canRestore: !stale && !conflicts.length && action !== 'keep',
      ...(ratingImpact ? { ratingImpact } : {}),
      ...(preferenceImpact ? { preferenceImpact } : {})
    }
  }
}
