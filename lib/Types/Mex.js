/**
 * Single source of truth for every w:mex (Pando / GraphQL) constant.
 *
 * RULE: no other file may declare its own query-id table. Duplicated tables
 * drift, and a single stale id makes the server answer with a legacy/binary
 * body that surfaces to users as things like:
 *     "…120363414… is not valid JSON"  (JSON.parse on a non-JSON payload)
 *     "GraphQL server error: Bad Request"
 *
 * Maintenance:
 *  - `XWAPaths` keys are the enum names callers use; VALUES are the paths the
 *    server actually returns inside `data`. Two entries intentionally differ
 *    (key ≠ value) because WhatsApp names the data node differently from the
 *    operation: `xwa2_newsletter_metadata` -> `xwa2_newsletter` and
 *    `xwa2_newsletter_admin_count` -> `xwa2_newsletter_admin`.
 *  - Ids rotate. Users can hot-fix a rotated id without forking the library:
 *        makeWASocket({ ..., mexQueryIdOverrides: { METADATA: '1234…' } })
 *    Here `mexQueryIdOverrides` keys are the QueryIds enum names (or the
 *    numeric id itself, which simply passes through unchanged).
 *
 * Verification (2026-10): ids marked `✔ whatsmeow` were checked against
 * tulir/whatsmeow main (newsletter.go); ids marked `✔ baileys` match
 * WhiskeySockets/Baileys master (src/Types/Mex.ts). Where both agree, both are
 * named.
 */
export var XWAPaths;
(function (XWAPaths) {
    XWAPaths["xwa2_newsletter_create"] = "xwa2_newsletter_create";
    XWAPaths["xwa2_newsletter_subscribers"] = "xwa2_newsletter_subscribers";
    XWAPaths["xwa2_newsletter_subscribed"] = "xwa2_newsletter_subscribed";
    XWAPaths["xwa2_newsletter_view"] = "xwa2_newsletter_view";
    // update/mutation responses come back under `xwa2_newsletter_update`
    XWAPaths["xwa2_newsletter_update"] = "xwa2_newsletter_update";
    // key ≠ value on purpose (server-side data node name)
    XWAPaths["xwa2_newsletter_metadata"] = "xwa2_newsletter";
    // key ≠ value on purpose (server-side data node name)
    XWAPaths["xwa2_newsletter_admin_count"] = "xwa2_newsletter_admin";
    XWAPaths["xwa2_newsletter_mute_v2"] = "xwa2_newsletter_mute_v2";
    XWAPaths["xwa2_newsletter_unmute_v2"] = "xwa2_newsletter_unmute_v2";
    XWAPaths["xwa2_newsletter_follow"] = "xwa2_newsletter_follow";
    XWAPaths["xwa2_newsletter_unfollow"] = "xwa2_newsletter_unfollow";
    XWAPaths["xwa2_newsletter_join_v2"] = "xwa2_newsletter_join_v2";
    XWAPaths["xwa2_newsletter_leave_v2"] = "xwa2_newsletter_leave_v2";
    XWAPaths["xwa2_newsletter_change_owner"] = "xwa2_newsletter_change_owner";
    XWAPaths["xwa2_newsletter_demote"] = "xwa2_newsletter_demote";
    XWAPaths["xwa2_newsletter_delete_v2"] = "xwa2_newsletter_delete_v2";
    XWAPaths["xwa2_fetch_account_reachout_timelock"] = "xwa2_fetch_account_reachout_timelock";
    XWAPaths["xwa2_message_capping_info"] = "xwa2_message_capping_info";
})(XWAPaths || (XWAPaths = {}));
export var QueryIds;
(function (QueryIds) {
    QueryIds["CREATE"] = "8823471724422422"; // ✔ baileys (variables: { input })
    QueryIds["UPDATE_METADATA"] = "24250201037901610"; // ✔ baileys (legacy update id, kept for compat)
    QueryIds["JOB_MUTATION"] = "7150902998257522"; // ✔ whatsmeow (mutationUpdateNewsletter) — name/description/picture/reaction-mode
    QueryIds["METADATA"] = "6563316087068696"; // ✔ whatsmeow + baileys (queryFetchNewsletter)
    QueryIds["SUBSCRIBERS"] = "9800646650009898"; // ✔ whatsmeow (queryNewsletterSubscribers) — was 9783111038412085
    QueryIds["SUBSCRIBED"] = "6388546374527196"; // ✔ whatsmeow + baileys (querySubscribedNewsletters)
    QueryIds["FOLLOW"] = "9926858900719341"; // ✔ whatsmeow (mutationFollowNewsletter)
    QueryIds["UNFOLLOW"] = "6392786840836363"; // ✔ whatsmeow (mutationUnfollowNewsletter)
    QueryIds["MUTE"] = "6274038279359549"; // ✔ whatsmeow (mutationMuteNewsletter)
    QueryIds["UNMUTE"] = "6068417879924485"; // ✔ whatsmeow (mutationUnmuteNewsletter)
    QueryIds["ADMIN_COUNT"] = "7130823597031706"; // ✔ baileys (unverified upstream)
    QueryIds["CHANGE_OWNER"] = "7341777602580933"; // ✔ baileys (unverified upstream)
    QueryIds["DEMOTE"] = "6551828931592903"; // ✔ baileys (unverified upstream)
    QueryIds["DELETE"] = "30062808666639665"; // ✔ baileys (unverified upstream)
    QueryIds["REACHOUT_TIMELOCK"] = "23983697327930364";
    QueryIds["MESSAGE_CAPPING_INFO"] = "24503548349331633";
})(QueryIds || (QueryIds = {}));
/**
 * Resolve a query id, applying user overrides (`mexQueryIdOverrides` in the
 * socket config). Accepts an enum name (`'METADATA'`) or a raw numeric id.
 * Unknown ids that already look numeric pass straight through, so a caller may
 * always hardcode a freshly captured id.
 */
export const resolveQueryId = (queryId, overrides) => {
    if (overrides && queryId in overrides) {
        const override = overrides[queryId];
        if (override) {
            return String(override);
        }
    }
    if (typeof queryId === 'string' && queryId in QueryIds) {
        // not reachable for the enum values themselves (they are the numeric ids)
        return QueryIds[queryId];
    }
    return queryId;
};
//# sourceMappingURL=Mex.js.map
