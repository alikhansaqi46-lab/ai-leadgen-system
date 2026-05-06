# WhatsApp Business API Setup Guide

## Overview

The LeadGen System now supports REAL WhatsApp automation using WhatsApp Business API via:
- **Twilio** (Recommended - easier setup)
- **Meta Cloud API** (Direct - more control)

## Features

✅ **Real Auto-Send**: Messages sent automatically without opening WhatsApp windows  
✅ **Status Tracking**: Real-time "Pending → Sending → Sent/Failed" status  
✅ **Test Mode**: Simulate sends without actually sending messages  
✅ **Retry Failed**: Retry failed messages with one click  
✅ **Safety Limits**: Max 50 messages per batch  
✅ **Delay Control**: 1-3 second delays between messages (avoid bans)  
✅ **Error Detection**: Automatically detects if number is not on WhatsApp  

---

## Setup Instructions

### 1. Twilio Setup (Recommended)

#### Step 1: Create Twilio Account
1. Go to [https://www.twilio.com](https://www.twilio.com)
2. Sign up for a free account
3. Verify your email and phone number

#### Step 2: Get WhatsApp Sandbox
1. In Twilio Console, go to **Messaging → Try it out → Send a WhatsApp message**
2. Join the sandbox by sending the code to the provided number
3. Note down your **Sandbox Number** (format: `whatsapp:+1234567890`)

#### Step 3: Get API Credentials
1. Go to **Account → API keys & tokens**
2. Copy your **Account SID** (starts with `AC`)
3. Copy your **Auth Token**
4. Your WhatsApp Number is the sandbox number

#### Step 4: Configure Backend
Edit `backend/.env` and add:

```env
WHATSAPP_PROVIDER=twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
```

**Note**: In sandbox mode, you can only message numbers that have joined your sandbox.

#### Step 5: Request Production Access (Optional)
To send to any number:
1. Go to **Messaging → Senders → WhatsApp Senders**
2. Request approval for your business
3. This takes 1-2 weeks for approval

---

### 2. Meta Cloud API Setup (Alternative)

#### Step 1: Create Meta App
1. Go to [https://developers.facebook.com/apps](https://developers.facebook.com/apps)
2. Create a new app → Business type
3. Add **WhatsApp** product to your app

#### Step 2: Configure WhatsApp
1. In your app, go to **WhatsApp → API Setup**
2. Select or create a Business Account
3. Add a phone number (you'll receive a verification code)
4. Note down your **Phone Number ID**

#### Step 3: Generate Access Token
1. Go to **WhatsApp → Getting Started**
2. Generate a **Permanent Access Token**
3. Copy the token (starts with `EAA`)

#### Step 4: Configure Backend
Edit `backend/.env` and add:

```env
WHATSAPP_PROVIDER=meta
WHATSAPP_TOKEN=EAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
PHONE_NUMBER_ID=1xxxxxxxxxxxxxx
```

#### Step 5: Webhook Setup (Optional for replies)
To receive incoming messages, you'll need to set up webhooks.

---

### 3. Test Mode

Before sending real messages, enable **Test Mode**:

1. In the frontend UI, click **"🔴 Live Mode ON"** button
2. It will switch to **"🧪 Test Mode ON"**
3. Click **"Send WhatsApp (Auto)"**
4. Check browser console - you'll see what WOULD be sent
5. No actual messages are sent in test mode

---

### 4. Sending Messages

#### Send to Multiple Leads:
1. Select leads with phone numbers
2. Click **"Send WhatsApp (Auto)"**
3. Watch real-time progress:
   - 🟡 Pending
   - 🔵 Sending...
   - 🟢 Sent ✅
   - 🔴 Failed ❌

#### Retry Failed:
1. If any messages fail, a **"🔄 Retry Failed (X)"** button appears
2. Click to retry only the failed ones

#### Legacy Mode (wa.me links):
- Still available as **"Legacy Mode"** button
- Opens WhatsApp windows manually
- Useful if API is not configured

---

## API Endpoints

### Send WhatsApp Message
```http
POST /api/send-whatsapp
Content-Type: application/json

{
  "phone": "+1234567890",
  "message": "Hi there!",
  "testMode": false
}
```

**Response:**
```json
{
  "success": true,
  "message": "WhatsApp message sent to +1234567890",
  "messageId": "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "status": "sent"
}
```

### Check WhatsApp Status
```http
GET /api/whatsapp-status
```

**Response:**
```json
{
  "configured": true,
  "provider": "twilio",
  "testMode": false
}
```

---

## Error Handling

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| "WhatsApp not configured" | Missing env vars | Add API credentials to `.env` |
| "Phone number not on WhatsApp" | Number doesn't use WhatsApp | Try a different number |
| "Invalid phone number" | Bad format | Ensure number includes country code |
| "All messages failed" | API down/wrong credentials | Check credentials, enable test mode |

### Rate Limits

- **Twilio Sandbox**: ~3 messages per second
- **Meta API**: ~80 messages per second (after approval)
- **Our System**: Max 50 per batch, 1-3 sec delay between messages

---

## Campaign Message Templates

Messages support variable substitution:

```
Hi {name}, I found your {niche} business in {city}...

We at {company} can help you with {product}.

Special offer: {offer}
```

**Variables:**
- `{name}` - Business name
- `{city}` - City
- `{niche}` - Business type
- `{company}` - Your company name
- `{product}` - Your product/service
- `{offer}` - Current offer

Set these in **Campaign Settings** panel.

---

## Security & Best Practices

1. **Never commit `.env` files** - They contain sensitive API keys
2. **Use Test Mode first** - Always test before live sending
3. **Respect rate limits** - Don't modify delay below 1 second
4. **Get opt-in consent** - Ensure leads have agreed to receive messages
5. **Monitor for blocks** - If messages fail repeatedly, check if number is blocked

---

## Troubleshooting

### "WhatsApp API not configured" error
- Check `.env` file exists in `backend/` folder
- Verify all required variables are set
- Restart backend server after changing `.env`

### Messages not sending
- Check browser console for detailed logs
- Enable Test Mode to see what would be sent
- Verify phone numbers include country code (+1, +44, etc.)

### "Phone number not on WhatsApp" error
- The recipient doesn't have WhatsApp
- Try with your own number first to test
- In Twilio sandbox, recipient must join sandbox first

---

## Support

For issues with:
- **Twilio API**: [Twilio Support](https://support.twilio.com)
- **Meta API**: [Meta Developers](https://developers.facebook.com/support)
- **This Integration**: Check browser console and backend logs
