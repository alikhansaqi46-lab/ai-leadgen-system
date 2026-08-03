# WhatsApp ↔ Email Inbox Feature Parity Checklist

Verified: 2026-07-31 via `backend/scripts/verify-whatsapp-inbox-parity.js` (API) + shared `InboxPage` architecture.

## Brought to WhatsApp (parity achieved)

| Feature | Status | Implementation |
|---|---|---|
| Full conversation history | Done | Shared `conversationStorage` + unified Inbox |
| Outbound / inbound messages | Done | Same thread model as Email |
| Images in timeline | Done | `metadata.imageUrl` / `attachments` + Inbox media preview |
| Documents / video / audio preview | Done | Same media renderer |
| AI Auto Reply | Done | Shared `autonomousReplyService` (not a second AI stack) |
| Per-conversation Auto Reply toggle | Done | `POST /api/ai/conversations/:id/settings` |
| Global WhatsApp Auto Reply | Done | Settings → AI Sales Agent → Autonomous WhatsApp Replies |
| AI reply appears in Inbox | Done | Stored as `source: auto-ai` message |
| AI reply sent on WhatsApp | Done | `whatsappTransport.sendText` from shared engine |
| AI status / events in timeline | Done | `ai_action` events (reply, takeover, resume) |
| Human Takeover | Done | Stops AI immediately (`humanTakeover` + `human_active`) |
| Resume AI | Done | Clears takeover, restores `ai_active` |
| Waiting / AI Active / Human Active | Done | Shared `deriveNotificationStatus` |
| Quote Sent / Invoice Sent | Done | Conversation status updated on send (both channels) |
| Closed / Archived | Done | Shared archive + status badges |
| Quote / Invoice actions | Done | Shared Quote drawers / ThreadDocumentActions |
| Archive / Delete | Done | Shared thread toolbar |
| Timeline | Done | Shared timeline merge in thread |
| Customer profile + notes | Done | Shared CustomerPanel |
| AI suggestions / drafts | Done | Shared `generateReply` |
| Contact sync (no duplicate threads) | Done | Phone identity: personal contact → lead → `orphan_<phone>` |

## Intentionally not applicable to WhatsApp

| Feature | Why N/A |
|---|---|
| Email subject / Re: threading headers | Email MIME concept |
| Gmail open / click tracking | Email tracking pixels & links |
| CID inline HTML email rendering | Email HTML bodies |
| SMTP / OAuth mailbox sync | Email transport only |

## Channel-only differences (by design)

| Concern | Email | WhatsApp |
|---|---|---|
| Transport | Gmail / SMTP | Baileys QR session |
| Recipient identity | Email address | Phone number |
| Delivery receipts | Opens/clicks | delivered / read ACK events |

## API verification results

All checks in `backend/logs/whatsapp-inbox-parity.json` passed, including:

- Media metadata persistence
- Takeover / resume persistence
- Auto-reply blocked during human takeover
- Per-conversation + global WhatsApp auto-reply settings
- Phone identity merge
- Archive path
- Timeline + Inbox listing

Live WhatsApp transport send was skipped in automated run (`VERIFY_WA_LIVE=1` to exercise). Transport delivery was already confirmed separately (ACK 463 resolved).
