import { Boom } from '@hapi/boom';
import { QueryIds, XWAPaths } from '../Types/index.js';
import { decryptMessageNode, generateMessageID, generateProfilePicture } from '../Utils/index.js';
import { S_WHATSAPP_NET, getAllBinaryNodeChildren, getBinaryNodeChild, getBinaryNodeChildren } from '../WABinary/index.js';
import { makeGroupsSocket } from './groups.js';
import { executeWMexQuery } from './mex.js';

/**
 * WhatsApp Channels (newsletters).
 *
 * All operation/query ids live in `Types/Mex.js` — this file must NOT declare
 * its own table. The previous local table shadowed the shared QueryIds enum,
 * which meant `QueryIds.SUBSCRIBED` was `undefined` here and got sent to the
 * server as a literal "undefined" query_id.
 */

const toNumber = value => {
    if (value === null || value === undefined || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Defensive metadata parse.
 *
 * Every field is optional on the wire: a channel without a description has no
 * `description` node at all, `/m1/...` pictures are often absent, and a lookup
 * for a non-existent channel returns a metadata object with `id: null`.
 * Returns `null` when the payload cannot be a real channel — callers decide
 * whether that is an error (metadata lookup) or a skip (subscribed list).
 */
export const parseNewsletterMetadata = raw => {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) {
        return null;
    }
    const thread = raw.thread_metadata ?? {};
    return {
        id: raw.id,
        state: raw.state?.type ?? null,
        creation_time: toNumber(thread.creation_time),
        name: thread.name?.text ?? '',
        nameTime: toNumber(thread.name?.update_time),
        description: thread.description?.text ?? '',
        descriptionTime: toNumber(thread.description?.update_time),
        invite: thread.invite ?? null,
        handle: thread.handle ?? null,
        picture: thread.picture?.direct_path ?? null,
        preview: thread.preview?.direct_path ?? null,
        reaction_codes: thread.settings?.reaction_codes?.value ?? null,
        subscribers: toNumber(thread.subscribers_count),
        verification: thread.verification ?? null,
        viewer_metadata: raw.viewer_metadata ?? null
    };
};

/**
 * Accepts, in order of preference:
 *  - a plain metadata object (what `executeWMexQuery` already unwrapped),
 *  - a GraphQL envelope `{ data: { xwa2_newsletter: … } }`,
 *  - a legacy binary `<iq>` node (kept for backwards compatibility).
 * Throws a 404 Boom when the channel does not exist (WA Web behaviour).
 */
export const extractNewsletterMetadata = (raw, isCreate) => {
    let meta = raw;
    if (raw && typeof raw === 'object' && raw.tag === 'iq') {
        let envelope;
        try {
            envelope = JSON.parse(getBinaryNodeChild(raw, 'result')?.content?.toString() ?? 'null');
        } catch {
            envelope = null;
        }
        meta = envelope?.data?.[isCreate ? XWAPaths.xwa2_newsletter_create : XWAPaths.xwa2_newsletter_metadata];
    } else if (raw && typeof raw === 'object' && raw.data && !raw.id) {
        meta = raw.data[isCreate ? XWAPaths.xwa2_newsletter_create : XWAPaths.xwa2_newsletter_metadata];
    }
    const parsed = parseNewsletterMetadata(meta);
    if (!parsed) {
        throw new Boom(isCreate ? 'Failed to create channel: unexpected response' : 'Channel not found', { statusCode: 404 });
    }
    return parsed;
};

export const makeNewsletterSocket = config => {
    const sock = makeGroupsSocket(config);
    const { authState, signalRepository, query, generateMessageTag, logger } = sock;

    const queryIdOverrides = config.mexQueryIdOverrides;

    // Every w:mex call goes through the shared implementation (typed Boom
    // errors, stale-id diagnostics, override support).
    const mexQuery = (variables, queryId, dataPath) =>
        executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag, queryIdOverrides);

    const newsletterQuery = async (jid, type, content) =>
        query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type,
                xmlns: 'newsletter',
                to: jid
            },
            content
        });

    // NOTE: hidden auto-follow block removed — no library should silently subscribe
    // the user's account to a hardcoded channel (backdoor pattern).

    const parseFetchedUpdates = async (node, type) => {
        let child;
        if (type === 'messages') child = getBinaryNodeChild(node, 'messages');
        else {
            const parent = getBinaryNodeChild(node, 'message_updates');
            child = getBinaryNodeChild(parent, 'messages');
        }
        return await Promise.all(
            getAllBinaryNodeChildren(child).map(async messageNode => {
                messageNode.attrs.from = child?.attrs.jid;
                const views = parseInt(getBinaryNodeChild(messageNode, 'views_count')?.attrs?.count || '0');
                const reactionNode = getBinaryNodeChild(messageNode, 'reactions');
                const reactions = getBinaryNodeChildren(reactionNode, 'reaction').map(({ attrs }) => ({
                    count: +attrs.count,
                    code: attrs.code
                }));
                const data = {
                    server_id: messageNode.attrs.server_id,
                    views,
                    reactions
                };
                if (type === 'messages') {
                    const { fullMessage: message, decrypt } = await decryptMessageNode(
                        messageNode,
                        authState.creds.me.id,
                        authState.creds.me.lid || '',
                        signalRepository,
                        logger
                    );
                    await decrypt();
                    data.message = message;
                }
                return data;
            })
        );
    };

    /**
     * Mutations that update channel metadata all share the same query
     * (JOB_MUTATION). The server answers with the updated metadata under
     * `xwa2_newsletter_update`; a null/empty answer means the mutation was
     * accepted but not applied (silent no-op), so we surface it instead of
     * pretending it worked.
     */
    const newsletterUpdate = async (jid, updates) => {
        const result = await mexQuery(
            // `settings` defaults to null (WA expects the key to be present),
            // but an explicit settings update (reaction mode) must win.
            { newsletter_id: jid, updates: { ...updates, settings: updates.settings ?? null } },
            QueryIds.JOB_MUTATION,
            XWAPaths.xwa2_newsletter_update
        );
        const parsed = parseNewsletterMetadata(result);
        if (!parsed) {
            throw new Boom(
                'Channel update returned no confirmation from the server (silent no-op). ' +
                    'The JOB_MUTATION query id is probably stale — override it with mexQueryIdOverrides.JOB_MUTATION.',
                { statusCode: 502, data: { jid, updates } }
            );
        }
        return parsed;
    };

    const newsletterReactionMode = async (jid, mode) =>
        newsletterUpdate(jid, { settings: { reaction_codes: { value: mode } } });

    /**
     * Fetch every channel this account follows, parsed.
     * The server occasionally returns null entries (and channels that were
     * deleted mid-flight); WA Web drops those, so we do too.
     */
    const fetchSubscribed = async () => {
        const result = await mexQuery({}, QueryIds.SUBSCRIBED, XWAPaths.xwa2_newsletter_subscribed);
        if (!Array.isArray(result)) return [];
        return result.map(parseNewsletterMetadata).filter(Boolean);
    };

    return {
        ...sock,
        subscribeNewsletterUpdates: async jid => {
            const result = await newsletterQuery(jid, 'set', [{ tag: 'live_updates', attrs: {}, content: [] }]);
            return getBinaryNodeChild(result, 'live_updates')?.attrs;
        },
        newsletterReactionMode,
        newsletterUpdateDescription: async (jid, description) => newsletterUpdate(jid, { description: description || '' }),
        newsletterUpdateName: async (jid, name) => newsletterUpdate(jid, { name }),
        newsletterUpdatePicture: async (jid, content) => {
            const { img } = await generateProfilePicture(content);
            return newsletterUpdate(jid, { picture: img.toString('base64') });
        },
        newsletterRemovePicture: async jid => newsletterUpdate(jid, { picture: '' }),
        newsletterUnfollow: async jid => mexQuery({ newsletter_id: jid }, QueryIds.UNFOLLOW, XWAPaths.xwa2_newsletter_leave_v2),
        /** Every channel this account follows (parsed). */
        newsletterSubscribed: fetchSubscribed,
        /** Alias kept for forks whose users expect this name. */
        newsletterFetchAllSubscribe: fetchSubscribed,
        newsletterFollow: async jid => mexQuery({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_join_v2),
        newsletterUnmute: async jid => mexQuery({ newsletter_id: jid }, QueryIds.UNMUTE, XWAPaths.xwa2_newsletter_unmute_v2),
        newsletterMute: async jid => mexQuery({ newsletter_id: jid }, QueryIds.MUTE, XWAPaths.xwa2_newsletter_mute_v2),
        newsletterCreate: async (name, description, picture) => {
            // Best-effort ToS notice: a failure here must not block creation.
            try {
                await query({
                    tag: 'iq',
                    attrs: { to: S_WHATSAPP_NET, xmlns: 'tos', id: generateMessageTag(), type: 'set' },
                    content: [{ tag: 'notice', attrs: { id: '20601218', stage: '5' }, content: [] }]
                });
            } catch (err) {
                logger?.debug({ err: err?.message }, 'newsletter create: ToS notice failed (continuing)');
            }
            const result = await mexQuery(
                {
                    input: {
                        name,
                        description: description ?? null,
                        picture: picture ? (await generateProfilePicture(picture)).img.toString('base64') : null,
                        settings: null
                    }
                },
                QueryIds.CREATE,
                XWAPaths.xwa2_newsletter_create
            );
            return extractNewsletterMetadata(result, true);
        },
        /**
         * @param {'invite'|'jid'} type
         * @param {string} key invite code/link or channel jid
         * @param {'GUEST'|'ADMIN'|'OWNER'|'SUBSCRIBER'} [role] optional view_role
         */
        newsletterMetadata: async (type, key, role) => {
            const input = { key, type: String(type).toUpperCase() };
            // Only send view_role when the caller asked for one — pinning it to
            // GUEST makes the server echo "GUEST" in viewer_metadata.role, which
            // makes "am I an admin of this channel?" unanswerable.
            if (role) input.view_role = role;
            const result = await mexQuery(
                {
                    input,
                    // whatsmeow sets this to false for invite lookups: there is no
                    // viewer relationship yet, and asking for it can fail the query.
                    fetch_viewer_metadata: input.type !== 'INVITE',
                    fetch_full_image: true,
                    fetch_creation_time: true
                },
                QueryIds.METADATA,
                XWAPaths.xwa2_newsletter_metadata
            );
            return extractNewsletterMetadata(result);
        },
        newsletterAdminCount: async jid => {
            const result = await mexQuery({ newsletter_id: jid }, QueryIds.ADMIN_COUNT, XWAPaths.xwa2_newsletter_admin_count);
            return result?.admin_count;
        },
        /**
         * List the followers of a channel.
         * @param {string} jid channel jid
         * @param {number} [count=20]
         */
        newsletterSubscribers: async (jid, count = 20) => {
            const result = await mexQuery(
                { input: { newsletter_id: jid, count } },
                QueryIds.SUBSCRIBERS,
                XWAPaths.xwa2_newsletter_subscribers
            );
            const edges = result?.subscribers?.edges;
            if (Array.isArray(edges)) return edges.map(edge => edge?.node ?? edge).filter(Boolean);
            return Array.isArray(result) ? result : [];
        },
        /**user is Lid, not Jid */
        newsletterChangeOwner: async (jid, user) =>
            mexQuery({ newsletter_id: jid, user_id: user }, QueryIds.CHANGE_OWNER, XWAPaths.xwa2_newsletter_change_owner),
        /**user is Lid, not Jid */
        newsletterDemote: async (jid, user) =>
            mexQuery({ newsletter_id: jid, user_id: user }, QueryIds.DEMOTE, XWAPaths.xwa2_newsletter_demote),
        newsletterDelete: async jid => mexQuery({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.xwa2_newsletter_delete_v2),
        /**if code wasn't passed, the reaction will be removed (if is reacted) */
        newsletterReactMessage: async (jid, server_id, code) => {
            await query({
                tag: 'message',
                attrs: { to: jid, ...(!code ? { edit: '7' } : {}), type: 'reaction', server_id, id: generateMessageID() },
                content: [
                    {
                        tag: 'reaction',
                        attrs: code ? { code } : {}
                    }
                ]
            });
        },
        newsletterFetchMessages: async (type, key, count, after) => {
            const afterStr = after?.toString();
            const result = await newsletterQuery(S_WHATSAPP_NET, 'get', [
                {
                    tag: 'messages',
                    attrs: {
                        type,
                        ...(type === 'invite' ? { key } : { jid: key }),
                        count: count.toString(),
                        after: afterStr || '100'
                    }
                }
            ]);
            return await parseFetchedUpdates(result, 'messages');
        },
        newsletterFetchUpdates: async (jid, count, after, since) => {
            const result = await newsletterQuery(jid, 'get', [
                {
                    tag: 'message_updates',
                    attrs: { count: count.toString(), after: after?.toString() || '100', since: since?.toString() || '0' }
                }
            ]);
            return await parseFetchedUpdates(result, 'updates');
        }
    };
};
