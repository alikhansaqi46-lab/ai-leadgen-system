# Email CRM System — Complete Technical Audit Report

**Date:** July 6, 2026

---

## 1. Complete Architecture

### Email CRM Flow (Frontend → Backend)

```
EmailPage.tsx → apiClient.ts → POST /api/campaign/send-with-preview
  → routes/campaign.js → unifiedSend.send()
    → emailService.sendEmailToLead()
      → emailOAuthService.sendViaGmailApi()
        → gmail.users.messages.send()
    → conversationStorage.addMessage()
    → campaignStorage.recordSent()
    → campaignStorage.scheduleFollowUps()
```

### Routes

| Route | File | Purpose |
|-------|------|---------|
| `GET /api/email/status` | `routes/email.js:25` | Email config check |
| `POST /api/email/send` | `routes/email.js:43` | Single email send |
| `POST /api/email/send-bulk` | `routes/email.js:112` | Bulk send (max 50) |
| `GET/POST/PUT/DELETE /api/email/templates` | `routes/email.js:204-248` | Template CRUD |
| `POST /api/email/receive` | `routes/email.js:253` | Inbound webhook |
| `POST /api/email/sync` | `routes/email.js:304` | Manual IMAP sync |
| `POST /api/campaign/send-with-preview` | `routes/campaign.js:470` | Unified campaign send |
| `GET /api/campaign/stats` | `routes/campaign.js:46` | Analytics |
| `GET /api/integrations` | `routes/integrations.js:96` | List integrations |
| `GET /api/integrations/:provider/oauth/url` | `routes/integrations.js:199` | OAuth consent URL |
| `GET /api/integrations/:provider/oauth/callback` | `routes/integrations.js:266` | OAuth callback |

### Services

| Service | File | Role |
|---------|------|------|
| `emailService` | `services/emailService.js` | System transporter + campaign email rendering |
| `emailOAuthService` | `services/emailOAuthService.js` | Gmail OAuth tokens + Gmail API sending |
| `emailInboxService` | `services/emailInboxService.js` | IMAP polling for inbound replies |
| `unifiedSend` | `services/unifiedSend.js` | Orchestrates all channel sends |
| `previewSend` | `services/previewSend.js` | Preview copies to user's own email |

### Middleware

| Route | Middleware |
|-------|-----------|
| `/api/email` | `requireEmailVerified` + `requireSubscription` |
| `/api/campaign` | `requireEmailVerified` |
| `/api/integrations` | `requireAuth` |

### Database Tables

| Table | Used For |
|-------|----------|
| `users` | Accounts, sender email, preview settings |
| `leads` | Lead data |
| `conversations` | Email threads |
| `messages` | Individual messages |
| `campaigns` | CRM pipeline (new/sent/replied/etc.) |
| `timeline_events` | Lead timeline |
| `outreach_drafts` | AI-generated drafts |
| `integrations.json` (FILE) | OAuth tokens — NOT in PostgreSQL |
| `email_templates.json` (FILE) | Templates — NOT in PostgreSQL |

---

## 2. Folder & File Map

### Backend — Gmail OAuth
- **`config/providers.js`** — Provider registry. Defines email provider as `oauth2` with Google scopes. **Single source of truth for scope config.**
- **`routes/integrations.js`** — OAuth URL generation, callback, token exchange, credential storage.
- **`services/emailOAuthService.js`** — Token exchange, refresh, Gmail API client, `sendViaGmailApi()`.

### Backend — Email Sending
- **`services/emailService.js`** — System transporter (EMAIL_USER/EMAIL_PASS for auth emails) + campaign email rendering + `sendEmailToLead()`.
- **`services/unifiedSend.js`** — All channel sends flow through here. Records conversation + campaign + timeline.
- **`services/previewSend.js`** — Preview/Trust Mode. Sends copy to user's own email.

### Backend — Inbox
- **`services/emailInboxService.js`** — IMAP polling every 60s. Matches replies to leads.
- **`routes/email.js`** — `/receive` webhook + `/sync` manual trigger.

### Backend — Campaigns
- **`routes/campaign.js`** — Analytics, pipeline, follow-ups, `/send-with-preview`.
- **`utils/campaignStorage.js`** — PostgreSQL-backed campaign records.

### Backend — Templates
- **`utils/emailTemplateStorage.js`** — JSON file-based. **Not workspace-scoped.**

### Backend — Drafts
- **`utils/draftStorage.js`** — PostgreSQL-backed. **Contains broken code.**

### Backend — Attachments
- **`services/emailOAuthService.js:243-275`** — Inline images in `sendViaGmailApi()`.
- **`server.js:580`** — Image upload endpoint.

### Backend — Auth
- **`services/authService.js`** — Login, signup, verification, password reset.
- **`routes/auth.js`** — All `/api/auth/*` endpoints.
- **`middleware/auth.js`** — `requireAuth`, `requireEmailVerified`.
- **`middleware/subscription.js`** — Subscription gate (bypasses admin/super_admin).
- **`utils/userStorage.js`** — User data, sender email, preview settings.

### Backend — SMTP
- **`services/emailService.js:24-36`** — System SMTP (EMAIL_USER/EMAIL_PASS). Auth emails only.
- **`services/emailOAuthService.js:79-118`** — OAuth2 SMTP transporter via nodemailer. **Used only by previewSend.**

### Backend — Email Tracking
- **No dedicated tracking module.** Only conversation-level sent/replied status.

### Frontend
- **`features/email/EmailPage.tsx`** (929 lines) — Email CRM UI, composer, lead table, pipeline.
- **`features/settings/SettingsPage.tsx`** (518 lines) — Gmail OAuth connect/disconnect, sender email.
- **`features/common/ConnectionCard.tsx`** (171 lines) — Reusable OAuth popup flow.
- **`features/inbox/InboxPage.tsx`** (1104 lines) — Unified inbox.
- **`lib/apiClient.ts`** — All API calls.

---

## 3. Duplicate Code

### 3.1 OAuth Popup Logic
- `SettingsPage.tsx:111-158` and `ConnectionCard.tsx:27-85` — identical popup + postMessage logic.
- **Fix:** Use `ConnectionCard` everywhere. Remove custom logic from `SettingsPage`.

### 3.2 Token Refresh Check
- `emailOAuthService.js:86-91` (getOAuthTransporter) and `emailOAuthService.js:152-160` (getGmailClient) — same expiry check + refresh pattern.
- **Fix:** Extract `getValidTokens(workspaceId)` helper.

### 3.3 Two Email Sending Paths
- **Gmail API path:** `sendEmailToLead()` → `sendViaGmailApi()` → `gmail.users.messages.send()` (campaign sends)
- **SMTP path:** `previewSend` → `getTransporter()` → `getOAuthTransporter()` → `nodemailer.sendMail()` (preview sends)
- **Fix:** All sends go through `sendViaGmailApi()`. Remove `getOAuthTransporter()`.

### 3.4 Inbound Email Processing
- `emailInboxService.js:92-310` (IMAP polling) and `routes/email.js:253-301` (webhook) — duplicate lead matching + conversation creation.
- **Fix:** Extract shared `processInboundEmail()` function.

### 3.5 Personalization Logic
- `emailService.js:46-52`, `campaign.js:513-517`, `EmailPage.tsx:388-393` — same `{name}/{city}/{niche}` replacement.
- **Fix:** Use `emailService.personalize()` everywhere.

### 3.6 workspaceOf Helper
- Defined identically in `email.js`, `integrations.js`, `campaign.js`, and every route file.
- **Fix:** Extract to shared utility.

---

## 4. Current Bugs

| # | Bug | Severity | File |
|---|-----|----------|------|
| 1 | Gmail OAuth scopes not granted | CRITICAL | `config/providers.js`, `routes/integrations.js` |
| 2 | `campaignStorage` not imported in emailInboxService | CRITICAL | `services/emailInboxService.js` |
| 3 | draftStorage.js has broken code (undefined `rows` variable) | HIGH | `utils/draftStorage.js:101-103` |
| 4 | Email templates not workspace-scoped | MEDIUM | `utils/emailTemplateStorage.js` |
| 5 | Integration storage is JSON file, not PostgreSQL | MEDIUM | `utils/integrationStorage.js` |
| 6 | Preview send uses SMTP path, not Gmail API | MEDIUM | `services/previewSend.js:69-84` |
| 7 | Inbox only polls 'default' workspace | MEDIUM | `services/emailInboxService.js:321` |
| 8 | IMAP uses access token without refresh | MEDIUM | `services/emailInboxService.js:36-47` |
| 9 | No email open/click tracking | LOW | N/A |
| 10 | No rate limiting (only 1.5s delay, no quota check) | MEDIUM | `routes/campaign.js:650` |
| 11 | Frontend drafts in localStorage (no cross-device sync) | LOW | `EmailPage.tsx:242-281` |
| 12 | Sender email input shown before OAuth connect (confusing UX) | LOW | `SettingsPage.tsx:283-301` |
| 13 | Excessive debug logging in production | LOW | `emailOAuthService.js`, `integrations.js` |

---

## 5. Root Cause Analysis

### BUG-1: Insufficient Scopes
- **Why:** OAuth URL requests `https://mail.google.com/ https://www.googleapis.com/auth/gmail.send email profile` but Google grants only `userinfo.profile openid userinfo.email`
- **File:** `config/providers.js:48` (scope definition), `routes/integrations.js:244-254` (URL building)
- **Correct design:** Use `https://mail.google.com/ email profile`. Ensure Google Cloud Console has Gmail scope added to consent screen.

### BUG-2: campaignStorage Not Imported
- **Why:** `require` statement was forgotten
- **File:** `services/emailInboxService.js`
- **Function:** `fetchUnreadEmails()` at line 253
- **Correct design:** Add `const campaignStorage = require('../utils/campaignStorage');`

### BUG-3: Broken draftStorage
- **Why:** Incomplete refactoring from JSON to dual-driver
- **File:** `utils/draftStorage.js:101-103` — `let rows;` never assigned
- **Correct design:** Complete or remove JSON driver fallback

### BUG-6: Preview Uses SMTP
- **Why:** `previewSend.js` was written before Gmail API migration
- **File:** `services/previewSend.js:69-84`
- **Correct design:** Call `sendViaGmailApi()` directly

### BUG-7: Only Default Workspace Polled
- **Why:** Deliberate MVP shortcut (comment on line 320)
- **File:** `services/emailInboxService.js:321`
- **Correct design:** Iterate all workspaces with connected email

### BUG-8: IMAP Token Not Refreshed
- **Why:** `getImapConfig()` reads stored access token without checking expiry
- **File:** `services/emailInboxService.js:36-47`
- **Correct design:** Call `refreshAccessToken()` before building IMAP config

---

## 6. Recommended Architecture

### One OAuth Flow
```
providers.js (scopes) → integrations.js (URL+callback) → emailOAuthService.js (tokens+Gmail client) → integrationStorage (persistence)
```
- Only `emailOAuthService.js` touches Google's OAuth API
- Only `integrationStorage.js` reads/writes tokens
- No other file creates OAuth2Client instances

### One SMTP Flow
```
emailService.js
  ├─ getSystemTransporter() → auth emails only (EMAIL_USER/EMAIL_PASS)
  └─ sendEmailToLead() → sendViaGmailApi() → gmail.users.messages.send()
```
- Remove `getOAuthTransporter()` — no second sending path
- Preview sends also use `sendViaGmailApi()`

### One Inbox Flow
```
emailInboxService.js
  ├─ start() → polls ALL workspaces with connected email
  ├─ syncNow(workspaceId) → manual trigger
  └─ processInboundEmail() → shared function for IMAP + webhook
```
- Token refresh before IMAP connect
- Both IMAP and webhook call `processInboundEmail()`

### One Campaign Flow
```
routes/campaign.js → unifiedSend.send() → sendViaGmailApi() + conversationStorage + campaignStorage + timelineStorage
```
- ALL sends through `unifiedSend.send()`
- No direct `sendEmailToLead()` calls from routes

### One Auth Flow
- Already clean. No changes needed.

---

## 7. Refactoring Plan

| Step | Priority | Files to Edit | Files to Delete | Expected Result | Risks |
|------|----------|---------------|-----------------|-----------------|-------|
| 1. Fix OAuth scopes | CRITICAL | `config/providers.js`, Google Cloud Console | — | Gmail scopes granted | Users must re-auth |
| 2. Fix campaignStorage import | CRITICAL | `services/emailInboxService.js` | — | Inbound replies update CRM | None |
| 3. Fix draftStorage | HIGH | `utils/draftStorage.js` | — | Drafts work in JSON mode | Low |
| 4. Unify sending path | HIGH | `services/previewSend.js`, `services/emailService.js`, `services/emailOAuthService.js` | Remove `getOAuthTransporter()` | One send path | Preview fails if API down (same as campaigns) |
| 5. Shared inbound processing | MEDIUM | `services/emailInboxService.js`, `routes/email.js` | — | One inbound path | Low |
| 6. Migrate integrations to PostgreSQL | MEDIUM | `utils/integrationStorage.js` | — | Tokens in DB | Migration needed |
| 7. Workspace-scoped templates | MEDIUM | `utils/emailTemplateStorage.js`, `routes/email.js` | — | Template isolation | Existing templates need migration |
| 8. Multi-workspace inbox | MEDIUM | `services/emailInboxService.js`, `utils/integrationStorage.js` | — | All workspaces polled | More IMAP connections |
| 9. Remove debug logging | LOW | `emailOAuthService.js`, `integrations.js` | — | Clean production logs | None |
| 10. Add rate limiting | MEDIUM | `routes/campaign.js` | — | Gmail quota protection | Sends may be throttled |

---

## 8. Current Error: Insufficient Scopes

### Error
```
Request had insufficient authentication scopes.
```

### Where It Originates
- **Thrown by:** Google's Gmail API when `gmail.users.messages.send()` is called
- **Caught at:** `backend/services/emailOAuthService.js:294-301` in `sendViaGmailApi()`
- **Surfaces to user at:** `backend/routes/campaign.js:646` → `res.status(500)` → frontend error message

### Why It Happens

The OAuth token stored in `data/integrations.json` has these scopes:
```
https://www.googleapis.com/auth/userinfo.profile
openid
https://www.googleapis.com/auth/userinfo.email
```

**Gmail scopes are completely missing.** The token cannot access Gmail's API at all.

The scope requested in `config/providers.js:48` is:
```
https://mail.google.com/ https://www.googleapis.com/auth/gmail.send email profile
```

But Google only granted the profile/email scopes. This happens because:

1. **Google Cloud Console OAuth consent screen does not have Gmail scopes added.** The consent screen must explicitly list `https://mail.google.com/` as an approved scope. If it's not in the consent screen, Google silently drops it from the grant.

2. **The app may be in "Testing" mode.** In testing mode, only scopes explicitly added to the consent screen are granted. Unlisted scopes are silently dropped.

3. **Scope encoding may still be wrong.** The current code at `routes/integrations.js:244` does:
   ```javascript
   const scopeEncoded = provider.oauth.scope.split(' ').join('%20');
   ```
   This replaces spaces with `%20` but does NOT encode the scope URLs themselves. The `://` and `/` characters in `https://mail.google.com/` should be fine in a URL query parameter, but Google may be parsing them differently.

### What Permission Is Missing

- **`https://mail.google.com/`** — Full Gmail access (read, send, compose, modify)
- **`https://www.googleapis.com/auth/gmail.send`** — Gmail send-only access

Either one would fix the error. `https://mail.google.com/` is the broader scope that covers both sending (via API) and IMAP access (for inbox polling).

### Which File Is Responsible

1. **`backend/config/providers.js:48`** — Defines the scope string. This is the configuration source.
2. **`backend/routes/integrations.js:244-254`** — Builds the OAuth URL with the scope. This is where the scope is sent to Google.
3. **Google Cloud Console** — The OAuth consent screen configuration. This is where the scope must be approved.

### Fix (NOT implementing yet — for review)

1. In Google Cloud Console → APIs & Services → OAuth consent screen → Scopes → Add `https://mail.google.com/` and `https://www.googleapis.com/auth/gmail.send`
2. Simplify the scope in `providers.js` to: `https://mail.google.com/ email profile`
3. User must disconnect and reconnect Gmail to get a new token with correct scopes
4. Verify the granted scope in the OAuth callback logs

---

*End of report. No code has been modified. Awaiting review.*
