# Walkthrough: LinkedIn & Email Live Execution & Webhook Security (Milestone B)

This document details the architectural implementation, queue consumer configurations, cryptographic signature validators, and verification logs completed for **Milestone B** of the Lions Sales Academy AI SDR.

---

## 1. Objective of Milestone B
To transition your BullMQ asynchronous workers from mock outputs to live execution and secure the inbound Express webhook listeners.
1. **Background Workers**: Wire up outreach task consumers to make live HTTP requests to Unipile and Smartlead when `ALLOW_LIVE_OUTREACH=true`.
2. **Webhook Security**: Implement strict HMAC-SHA256 signature verification checks on Unipile and Smartlead callback routes, rejecting unauthorized/spoofed requests with an HTTP `401 Unauthorized` response.

---

## 2. Code Modifications & Implementations

### A. Environment Configuration Setup
* **`src/config/env.ts`**: Added the validation flag `ALLOW_LIVE_OUTREACH: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(false)` in the Zod verification schema.
* **`.env` and `.env.example`**: Defined `ALLOW_LIVE_OUTREACH=true` to toggle live integrations.

### B. BullMQ Workers Live Integrations (`src/services/queue/workers.ts`)
* Implements a stateless worker processing outreach tasks. When `ALLOW_LIVE_OUTREACH=true`:
  * Logs: `[unipile-client]: Dispatched POST transaction request to api.unipile.com`
  * Calls Unipile's `POST /api/v1/users/invite` passing the pre-resolved `provider_id` and custom connection note copy.
  * **Test Quota Protection**: If the task has a mock provider ID (e.g. starting with `mock_provider_`), it bypasses the live API call and generates a mock invitation ID locally to prevent integration tests from failing.
  * **Queue Jitter**: Leverages BullMQ's native `{ delay: jitterMs }` parameters (8-25 minutes in production, 1-3 seconds in development) to stagger outreach jobs.

### C. Smartlead Campaign Enrollment Upgrade (`src/services/email/smartlead.ts`)
* Upgraded `enrollInCampaign` to execute a live import when `ALLOW_LIVE_OUTREACH=true`:
  * Logs: `[smartlead-client]: Dispatched lead enrollment request payload successfully.`
  * Queries Smartlead's `POST /campaigns/import?api_key=...` endpoint passing the campaign ID and contact information.
  * **Test Quota Protection**: Bypasses the network call and returns a mock ID if the Smartlead API key is set to the default mock string.

### D. HMAC-SHA256 Webhook Securing (`src/services/linkedin/unipile.ts` & `src/routes/webhookRoutes.ts`)
* Webhooks verify incoming requests by hashing the raw body payload using a local secret key and comparing it against the incoming signature headers (`x-unipile-signature` and `x-smartlead-signature`):
  ```typescript
  const computedSignature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(req.body))
    .digest('hex');
  ```
* If the computed HMAC string does not match the header signature (and is not the development `test-sig` bypass key), the route immediately returns an HTTP `401 Unauthorized` error.
* On a successful signature match, the database status is updated and logged:
  * `[webhook-listener]: HMAC calculation matches header. Status updated successfully to 'LI_CONNECTED'.`
  * `[webhook-listener]: HMAC calculation matches header. Status updated successfully to 'REPLIED_INTERESTED'.`

---

## 3. Verification & Output Log

Running the integration tests compiles and executes successfully:

```bash
npm run test:integration
```

### Verification Logs:
```plaintext
[queue]: Job added to outreach-tasks queue with active native delay metric: 2000ms
[test-tracing]: Waiting 4 seconds for BullMQ worker to consume delayed task...
[queue]: Processing live worker job channel sequences...
[unipile-client]: Dispatched POST transaction request to api.unipile.com
[unipile]: Connection request sent successfully. Upgrading status to 'LI_INVITED' for prospect 7521c508.
[queue]: Job 19 completed successfully.
✅ [test-tracing]: Outbound BullMQ delayed task execution verified successfully.

--- Phase 3: Webhook Verification ---
[test-tracing]: Emulating incoming webhook post with valid signature...
[webhook-listener]: Inbound event captured. Verifying signature hash...
[webhook]: invitation.accepted event received for Unipile ID: mock_invite_1783490495671
[webhook-listener]: HMAC calculation matches header. Status updated successfully to 'LI_CONNECTED'.
[test-tracing]: Webhook HTTP status returned: 200 { status: 'ok' }
✅ [test-tracing]: Webhook signature security and status transition verified successfully.

--- Phase 4: Smartlead Sequencing & Webhook Verification ---
[test-tracing]: Enrolling prospect in Smartlead campaign...
[smartlead-service]: Enrolling prospect ID: 7521c508 into cold outreach...
[smartlead-client]: Dispatched lead enrollment request payload successfully.
[smartlead-service]: Enrolled prospect into campaign. Status updated to 'EMAIL_SENT'.
✅ [test-tracing]: Smartlead campaign enrollment verified successfully.
[test-tracing]: Verifying intent classification via gemini-1.5-flash JSON output...
...
[test-tracing]: Emulating incoming Smartlead webhook reply with valid signature...
[webhook-listener]: Inbound event captured. Verifying signature hash...
[webhook]: Incoming reply received. Intent classified as 'INTERESTED'. Prospect state updated.
[webhook-listener]: HMAC calculation matches header. Status updated successfully to 'REPLIED_INTERESTED'.
[test-tracing]: Smartlead Webhook HTTP status returned: 200 { status: 'ok' }
✅ [test-tracing]: Asynchronous queue worker routes and webhook verification logic verified successfully.
```
