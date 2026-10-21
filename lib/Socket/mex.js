import * as boom_1 from '@hapi/boom'
import * as WABinary_1 from '../WABinary/index.js'
import { resolveQueryId } from '../Types/Mex.js'

/**
 * Send a raw w:mex IQ.
 *
 * `queryId` may be a QueryIds value or an enum name (`'METADATA'`); it is
 * passed through `resolveQueryId` so `mexQueryIdOverrides` from the socket
 * config can hot-patch rotated ids without forking the library.
 */
export const wMexQuery = (variables, queryId, query, generateMessageTag, overrides) => {
    const resolvedQueryId = resolveQueryId(queryId, overrides)
    if (!resolvedQueryId) {
        // This is the bug class that used to surface as a server-side
        // "undefined" query_id: the caller referenced a constant that its own
        // local table never defined.
        throw new boom_1.Boom(`Missing w:mex query id for "${queryId}" — the id table is stale, pass it via mexQueryIdOverrides`, { statusCode: 400 })
    }
    return query({
        tag: 'iq',
        attrs: {
            id: generateMessageTag(),
            type: 'get',
            to: WABinary_1.S_WHATSAPP_NET,
            xmlns: 'w:mex'
        },
        content: [
            {
                tag: 'query',
                attrs: { query_id: resolvedQueryId },
                content: Buffer.from(JSON.stringify({ variables }), 'utf-8')
            }
        ]
    })
}

/**
 * Run a w:mex query and pull `data[dataPath]` out of the GraphQL envelope.
 *
 * Failure modes are all turned into typed Boom errors:
 *  - HTTP/GraphQL error array   -> statusCode from extensions.error_code
 *  - non-JSON / binary payload  -> 400 with an actionable "stale id" hint
 *    (this is the classic symptom of a rotated query id: the server answers
 *    with a legacy/binary body and JSON.parse used to blow up with
 *    "Unexpected token … is not valid JSON")
 *  - missing data node          -> 400 "Failed to …, unexpected response structure"
 */
export const executeWMexQuery = async (variables, queryId, dataPath, query, generateMessageTag, overrides) => {
    const resolvedQueryId = resolveQueryId(queryId, overrides)
    const result = await wMexQuery(variables, queryId, query, generateMessageTag, overrides)
    const child = (0, WABinary_1.getBinaryNodeChild)(result, 'result')
    if (child?.content) {
        const raw = child.content.toString()
        let data
        try {
            data = JSON.parse(raw)
        } catch {
            throw new boom_1.Boom(
                `w:mex query ${resolvedQueryId} returned a non-JSON response — the query id is probably stale/rotated. ` +
                    'Update it with makeWASocket({ mexQueryIdOverrides: { <EnumName>: "<new id>" } }) ' +
                    'or open an issue with the captured query_id.',
                { statusCode: 400, data: { queryId: resolvedQueryId, preview: raw.slice(0, 200) } }
            )
        }
        if (data?.errors && data.errors.length > 0) {
            const errorMessages = data.errors.map(err => err.message || 'Unknown error').join(', ')
            const firstError = data.errors[0]
            const errorCode = firstError.extensions?.error_code || 400
            throw new boom_1.Boom(`GraphQL server error: ${errorMessages}`, { statusCode: errorCode, data: firstError })
        }
        const response = dataPath ? data?.data?.[dataPath] : data?.data
        if (typeof response !== 'undefined') {
            return response
        }
    }
    const action = (dataPath || '').startsWith('xwa2_')
        ? dataPath.substring(5).replace(/_/g, ' ')
        : dataPath?.replace(/_/g, ' ')
    throw new boom_1.Boom(`Failed to ${action || 'run the w:mex query'}, unexpected response structure (query id ${resolvedQueryId}).`, {
        statusCode: 400,
        data: { queryId: resolvedQueryId, result }
    })
}
