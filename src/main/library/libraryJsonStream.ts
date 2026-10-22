import { createReadStream } from 'node:fs'
import { parser, type Token } from 'stream-json/parser.js'
import { Assembler } from 'stream-json/assembler.js'
import { MAX_JSON_NESTING_DEPTH } from '../security/jsonSafety.ts'

export interface LibraryJsonValue {
  field: string
  value: unknown
  arrayItem?: boolean
}

/** Streams array members, never assembling the tracks or file-index array. */
export async function* streamLibraryJson(filePath: string): AsyncGenerator<LibraryJsonValue> {
  const tokens = parser.asStream({ streamValues: false })
  const source = createReadStream(filePath)
  source.on('error', (error) => tokens.destroy(error))
  source.pipe(tokens)
  let depth = 0
  let root: 'object' | 'array' | undefined
  let field = ''
  let arrayField = ''
  let assembly: Assembler | null = null
  let assemblyDepth = 0
  const fields = new Set<string>()
  const arrays = new Set<string>()
  try {
    for await (const raw of tokens) {
      const token = raw as Token
      const opens = token.name === 'startObject' || token.name === 'startArray'
      const closes = token.name === 'endObject' || token.name === 'endArray'
      if (opens && depth + 1 > MAX_JSON_NESTING_DEPTH)
        throw new Error('Music library JSON is too deeply nested')
      if (!root) {
        if (token.name !== 'startArray' && token.name !== 'startObject')
          throw new Error('Music library must be an array or object')
        root = token.name === 'startArray' ? 'array' : 'object'
        arrayField = root === 'array' ? 'tracks' : ''
        if (root === 'array') arrays.add('tracks')
        depth++
        continue
      }
      if (root === 'object' && depth === 1 && token.name === 'keyValue') {
        field = token.value
        if (fields.has(field)) throw new Error(`Duplicate music library field: ${field}`)
        fields.add(field)
        continue
      }
      if (!assembly && root === 'object' && depth === 1 && token.name === 'startArray') {
        arrayField = field
        arrays.add(field)
        depth++
        continue
      }
      if (!assembly && closes) {
        depth--
        if (depth === 1 && root === 'object') arrayField = ''
        continue
      }
      if (!assembly) {
        assembly = new Assembler()
        assemblyDepth = depth
      }
      assembly.consume(token)
      if (opens) depth++
      if (closes) depth--
      if (assembly.done && depth === assemblyDepth) {
        yield { field: arrayField || field, value: assembly.current, arrayItem: !!arrayField }
        assembly = null
      }
    }
    if (!root || depth !== 0 || assembly) throw new Error('Incomplete music library JSON')
    if (!arrays.has('tracks') && !arrays.has('entries'))
      throw new Error('Music library is missing its records array')
    for (const name of ['tracks', 'entries', 'folders', 'exclusions'])
      if (fields.has(name) && !arrays.has(name))
        throw new Error(`Music library ${name} must be an array`)
    for (const name of ['version', 'revision', 'libraryRevision'])
      if (arrays.has(name)) throw new Error(`Music library ${name} must not be an array`)
    // Empty arrays still need a schema signal for validation.
    yield { field: '$arrays', value: [...arrays] }
  } finally {
    source.destroy()
    tokens.destroy()
  }
}
