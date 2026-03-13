# Submission Notes

## Overview
This workflow receives an incident payload via a Webhook trigger, normalizes and 
validates it using JavaScript, and sends notifications to Slack and Office 365 
using offline mock APIs. Failures are logged to a local file via a lightweight 
HTTP logger server.

---

## How to Run

### Prerequisites
- Node.js 18+
- n8n installed globally (`npm install -g n8n`)

### Step 1 — Install dependencies
From the repo root:
```bash
npm install
```

### Step 2 — Start mock servers + failure logger

Option A — Run everything together:
```bash
npm run start
```

Option B — Run separately in different terminal tabs:
```bash
# Tab 1 — Slack mock on :4010 and MS mock on :4020
npm run mocks

# Tab 2 — Failure logger on :4030
npm run failure-logger
```

### Step 3 — Start n8n
```bash
# Tab 3
n8n start
```
Open http://localhost:5678 in your browser.

### Step 4 — Import the workflow
1. Open http://localhost:5678
2. Click "Add Workflow" → "Import from file"
3. Select `submission/workflow.json`
4. Toggle the workflow to **Active** (top-right switch)

### Step 5 — Send a test incident
```bash
# Tab 4 — from repo root
curl -X POST http://localhost:5678/webhook/incident \
  -H "Content-Type: application/json" \
  -d @fixtures/incidents/INC-10001.json
```

### Step 6 — Verify outputs
- Slack mock returns: `{"ok": true, "channel": "#oncall-alerts", ...}`
- O365 mock returns: `{}` (empty body = accepted by Microsoft Graph)

### Step 7 — Test with failure injection
```bash
# Stop mocks (Ctrl+C in Tab 1), then restart with failures:
SLACK_FAIL_429_N=2 MS_FAIL_500_N=1 npm run mocks
```
Then curl again with a different incident to trigger retries:
```bash
curl -X POST http://localhost:5678/webhook/incident \
  -H "Content-Type: application/json" \
  -d @fixtures/incidents/INC-10002.json
```

---

## Workflow Architecture
```
Webhook (POST /incident)
  └→ Code Node (validate + normalize)
        ├→ Slack Notify — HTTP POST → localhost:4010/chat.postMessage
        │     └→ IF success?
        │           ├→ TRUE  → done
        │           └→ FALSE → HTTP POST → localhost:4030/log-failure
        │
        └→ O365 Email — HTTP POST → localhost:4020/me/sendMail
              └→ IF success?
                    ├→ TRUE  → done
                    └→ FALSE → HTTP POST → localhost:4030/log-failure
```

---

## Nodes Explained

### 1. Webhook Node
- Listens on `POST /incident`
- Production URL: `http://localhost:5678/webhook/incident`
- Test URL: `http://localhost:5678/webhook-test/incident`
- Accepts JSON incident payload from `fixtures/incidents/`

### 2. Code Node (JavaScript)
Performs all normalization logic:
- **Field validation** — throws if any of `incidentId`, `severity`, `title`, 
  `createdAt` are missing
- **Severity mapping** — converts `P1→1`, `P2→2`, `P3→3`, `P4→4`
- **DedupeKey generation** — generates a unique hash key (see formula below)
- **Deduplication check** — rejects duplicate events using workflow static data
- **Description truncation** — cuts description to 240 characters
- **Message building** — creates a clean human-friendly message used by both 
  Slack and email

### 3. Slack Notify Node (HTTP Request)
- **URL**: `http://127.0.0.1:4010/chat.postMessage`
- **Method**: POST
- **Headers**: `Authorization: Bearer slack-test-token`
- **Body**:
```json
{
  "channel": "#oncall-alerts",
  "text": "<normalized message>"
}
```
- **Retry**: enabled — max 5 tries, 2000ms wait between attempts

### 4. O365 Email Node (HTTP Request)
- **URL**: `http://127.0.0.1:4020/me/sendMail`
- **Method**: POST
- **Headers**: `Authorization: Bearer ms-test-token`
- **Body**:
```json
{
  "message": {
    "subject": "[P2] Search latency elevated - INC-10001",
    "body": {
      "contentType": "Text",
      "content": "<normalized message>"
    },
    "toRecipients": [
      {
        "emailAddress": {
          "address": "oncall@example.com"
        }
      }
    ]
  }
}
```
- **Retry**: enabled — max 5 tries, 2000ms wait between attempts

### 5. IF Nodes (Slack Success? / O365 Success?)
- Checks the HTTP response status code
- Routes to error branch if status is not 200

### 6. Failure Logger HTTP Request Nodes
- On error branch after each IF node
- Sends failure record to local failure logger server
- **URL**: `http://127.0.0.1:4030/log-failure`
- **Method**: POST
- **Body**:
```json
{
  "timestamp": "<iso timestamp>",
  "service": "slack or o365",
  "incidentId": "<incidentId>",
  "statusCode": "<statusCode>",
  "error": "<error message>"
}
```

---

## How Retries / Backoff Work

Both Slack Notify and O365 Email HTTP Request nodes are configured with:
- **On Error**: Retry on Fail
- **Max Tries**: 5
- **Wait Between Tries**: 2000ms

This means on a 429 (rate limit) or 5xx (server error), n8n will automatically 
retry up to 5 times with a 2 second wait between each attempt before giving up 
and routing to the error branch.

4xx errors other than 429 (e.g. 400 Bad Request, 401 Unauthorized) are not 
retried — n8n routes them directly to the error branch immediately.

---

## How Dedupe / Idempotency Works

A `dedupeKey` is generated in the Code node using a djb2-style hash function 
(crypto module is not available in n8n Code nodes).

### DedupeKey Formula
```
rawKey    = incidentId + "|" + severity + "|" + createdAt
dedupeKey = simpleHash(rawKey)
```

### Example
```
Input:  "INC-10001|P2|2026-02-25T17:20:00Z"
Output: "a3f1c2e9"
```

### Hash function used
```javascript
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}
```

### How duplicates are prevented
- On every execution the Code node reads n8n's `$getWorkflowStaticData('global')`
- If the dedupeKey already exists in static data → throws an error and stops 
  (no Slack or email sent)
- If the dedupeKey is new → stores it in static data and continues processing
- Replaying the exact same incident payload will be rejected after the first run

---

## Where Failure Records Are Written

Failures are logged via a lightweight local HTTP server (`submission/failure-logger.js`) 
running on port `4030`.

### Why we used an HTTP logger instead of direct file writing
n8n's Code node sandbox does not allow Node.js built-in modules such as `fs` 
or `crypto`. To work around this limitation, we created a lightweight local HTTP 
server that runs on port `4030` and accepts failure records via POST requests 
and logs them to the console.

This approach also makes the solution more portable — any machine running the 
assessment just needs to run `npm run failure-logger` and the logging works 
without any file permission issues.

### How the error branch works
```
HTTP Node fails after 5 retries
  └→ IF node checks statusCode
        └→ FALSE branch → HTTP POST to localhost:4030/log-failure
                            └→ failure-logger.js logs the failure record
```

### Failure record format
Each failure record posted to the logger is a JSON object:
```json
{
  "timestamp": "2026-03-13T10:00:00.000Z",
  "service": "slack",
  "incidentId": "INC-10001",
  "statusCode": 429,
  "error": "Too Many Requests"
}
```

### Starting the failure logger
```bash
npm run failure-logger
# or
node submission/failure-logger.js
```
Listens on `http://localhost:4030/log-failure`
