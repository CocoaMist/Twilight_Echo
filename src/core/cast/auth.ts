import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import {
  REMOTE_COMMAND_WINDOW_MS,
  REMOTE_MAX_COMMANDS_PER_WINDOW,
  REMOTE_PAIR_MAX_ATTEMPTS,
  REMOTE_PAIR_WINDOW_MS,
  REMOTE_PIN_LENGTH,
  REMOTE_TOKEN_BYTES
} from '../../shared/remoteControl.ts'

export function generateRemotePin(length = REMOTE_PIN_LENGTH): string {
  const size = Math.max(4, Math.min(8, length))
  let pin = ''
  for (let i = 0; i < size; i++) {
    pin += String(randomInt(0, 10))
  }
  return pin
}

export function generateRemoteToken(): string {
  return randomBytes(REMOTE_TOKEN_BYTES).toString('base64url')
}

export function safeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export class SlidingWindowRateLimiter {
  private readonly timestamps: number[] = []
  private readonly now: () => number
  private readonly max: number
  private readonly windowMs: number

  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.max = max
    this.windowMs = windowMs
    this.now = now
  }

  tryConsume(at = this.now()): boolean {
    const cutoff = at - this.windowMs
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift()
    }
    if (this.timestamps.length >= this.max) return false
    this.timestamps.push(at)
    return true
  }

  reset(): void {
    this.timestamps.length = 0
  }
}

export class RemoteAuthSession {
  private pin: string
  private token: string | null = null
  private readonly pairLimiter: SlidingWindowRateLimiter
  private readonly commandLimiter: SlidingWindowRateLimiter
  private readonly now: () => number

  constructor(options: { now?: () => number; pin?: string } = {}) {
    this.now = options.now ?? Date.now
    this.pin = options.pin ?? generateRemotePin()
    this.pairLimiter = new SlidingWindowRateLimiter(
      REMOTE_PAIR_MAX_ATTEMPTS,
      REMOTE_PAIR_WINDOW_MS,
      this.now
    )
    this.commandLimiter = new SlidingWindowRateLimiter(
      REMOTE_MAX_COMMANDS_PER_WINDOW,
      REMOTE_COMMAND_WINDOW_MS,
      this.now
    )
  }

  getPin(): string {
    return this.pin
  }

  getToken(): string | null {
    return this.token
  }

  isPaired(): boolean {
    return this.token != null
  }

  rotatePin(): string {
    this.pin = generateRemotePin()
    this.token = null
    this.pairLimiter.reset()
    return this.pin
  }

  revokeToken(): void {
    this.token = null
  }

  /**
   * Pair with PIN. On success returns a new bearer token and invalidates the old one.
   */
  pair(pin: string): { ok: true; token: string } | { ok: false; reason: string } {
    if (!this.pairLimiter.tryConsume()) {
      return { ok: false, reason: 'too_many_pair_attempts' }
    }
    if (typeof pin !== 'string' || !safeEqualText(pin.trim(), this.pin)) {
      return { ok: false, reason: 'invalid_pin' }
    }
    this.token = generateRemoteToken()
    return { ok: true, token: this.token }
  }

  authorizeBearer(headerValue: string | null | undefined): boolean {
    if (!this.token) return false
    if (typeof headerValue !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim())
    if (!match) return false
    return safeEqualText(match[1]!.trim(), this.token)
  }

  authorizeTokenQuery(token: string | null | undefined): boolean {
    if (!this.token || typeof token !== 'string') return false
    return safeEqualText(token, this.token)
  }

  tryConsumeCommand(): boolean {
    return this.commandLimiter.tryConsume()
  }
}
