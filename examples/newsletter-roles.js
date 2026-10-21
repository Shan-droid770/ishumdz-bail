/**
 * Sample: channel member / admin / owner identification (ishumdz-bail)
 *
 * What you get:
 *   const { owner, admins, members } = await sock.newsletterMemberRoles(channelJid)
 *   await sock.newsletterMemberRole(channelJid, someLidOrPhoneJid)  // 'OWNER'|'ADMIN'|'MEMBER'
 *
 * Run: node examples/newsletter-roles.js <channel-jid | invite-link> [count]
 * QR scan pannitu, bot connect aana piragu channel member list print aagum.
 */

const {
    makeWASocket,
    useMultiFileAuthState,
    classifyDisconnect,
    parseNewsletterMemberTier
} = require('ishumdz-bail')

const CHANNEL = process.argv[2]
const COUNT = Number(process.argv[3] || 100)

const show = e => `${(e.displayName ?? '(no name)').padEnd(20)} ${e.id}${e.pn ? `  (${e.pn})` : ''}  role=${e.role ?? '-'} tier=${e.tier}`

async function identify(sock, channel, count) {
    // an invite link / code works too — resolve it to a jid first
    let jid = channel
    if (!channel.endsWith('@newsletter')) {
        const key = channel.split('/').pop() // https://whatsapp.com/channel/0029Va… → code
        jid = (await sock.newsletterMetadata('invite', key)).id
    }

    // one call → owner / admins / members
    const { owner, admins, members, total } = await sock.newsletterMemberRoles(jid, count)
    console.log(`\n# ${jid} — ${total} member(s) in this window`)
    console.log('OWNER  ', owner ? show(owner) : '(not in this window)')
    for (const a of admins) console.log('ADMIN  ', show(a))
    for (const m of members) console.log('MEMBER ', show(m))

    // single-member lookup (LID or phone jid, device suffixes tolerated)
    if (owner) console.log('\nwhois', owner.id, '→', await sock.newsletterMemberRole(jid, owner.id))

    // your own role on the channel + the server's admin count
    const meta = await sock.newsletterMetadata('jid', jid)
    const myRole = meta.viewer_metadata?.role
    console.log('my role:', myRole ?? '-', '→ tier', parseNewsletterMemberTier(myRole))
    console.log('server admin count:', await sock.newsletterAdminCount(jid))
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info')

    const sock = makeWASocket({
        auth: state,
        syncFullHistory: false,
        aiLabel: false
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'open') {
            console.log('✅ Bot connected')
            if (CHANNEL) identify(sock, CHANNEL, COUNT).catch(err => console.error('identify failed:', err))
            else console.log('usage: node examples/newsletter-roles.js <channel-jid | invite-link> [count]')
        }
        if (connection === 'close') {
            const info = classifyDisconnect(lastDisconnect?.error?.output?.statusCode)
            console.log('Disconnected:', info.message)
            if (info.shouldReconnect) setTimeout(startBot, info.backoffMs)
        }
    })
}

startBot()
