# Didit setup for Program Applications

The application code is ready for Didit's hosted KYC session flow. The applicant completes the ID capture inside an embedded verification window. The Supabase Edge Function retrieves the official decision, privately copies the verified front-ID image into Supabase Storage, and returns only the name, ID number, gender, address, and ID type needed by the form.

The Didit API key must never be added to a `REACT_APP_*` variable or committed to Git. It belongs only in Supabase Edge Function secrets.

## 1. Create and publish the Didit workflow

1. Sign in to the [Didit Business Console](https://business.didit.me/).
2. Select the Didit Application you created.
3. Open **Workflows** and create a **KYC** workflow in Simple Mode.
4. Enable these features in this order:
   - **ID Verification / OCR** — required; checks the document and extracts its data.
   - **Liveness** — strongly recommended; confirms a real person is present.
   - **Face Match 1:1** — strongly recommended; compares the live person with the ID portrait.
5. In the ID Verification settings:
   - Allow only **Philippines**.
   - Enable the Philippine document categories you intend to accept: **Passport**, **Identity Card**, and **Driver's License**.
   - Require the back side whenever Didit marks that document category as two-sided.
   - Decline expired documents and documents that fail authenticity checks.
6. Do not enable Database Validation unless the Didit Console specifically shows a live Philippine government source for your account. ID Verification plus Liveness and Face Match verifies document authenticity and ownership; it is not automatically a Philippine civil-registry lookup.
7. Publish the workflow. Copy its workflow UUID; this becomes `DIDIT_WORKFLOW_ID`.

The application intentionally keeps only the fields it needs: name, gender, ID type, ID number, and address. All displayed values remain editable so the applicant can correct an OCR mistake.

## 2. Copy the Didit API key

1. In the Business Console, select the same Application used by the workflow.
2. Open **API & Webhooks**.
3. Copy the **API Key**. This becomes `DIDIT_API_KEY`.
4. Keep it private. Do not paste it into `.env.local`, React code, screenshots, or Git.

## 3. Apply the Supabase migration

The migrations create the private verification session table, a private ID-image bucket, server-side verification enforcement, the unavailable-date RPC, a same-day schedule rule, and a concurrency-safe trigger that prevents more than one active application per date.

From the `StrandShare` directory in PowerShell:

```powershell
npx supabase login
npx supabase link --project-ref YOUR_SUPABASE_PROJECT_REF
npx supabase db push
```

Apply these migrations in this order:

```text
supabase/143_program_date_and_didit_verification.sql
supabase/144_private_verified_id_front_and_same_day_programs.sql
```

You may instead paste each file into **Supabase Dashboard → SQL Editor** and run 143 first, then 144. If 143 is already installed, run only 144.

The migration intentionally preserves any overlapping applications that already exist. Their dates remain unavailable, but the migration will still install successfully and all future submissions or reschedules are checked. Staff can release a reserved date by changing every existing application covering that date to **Rejected**.

## 4. Add server-side secrets

Replace the placeholders and use the exact deployed site origin. Do not add a trailing slash to an origin.

```powershell
npx supabase secrets set DIDIT_API_KEY="YOUR_DIDIT_API_KEY"
npx supabase secrets set DIDIT_WORKFLOW_ID="YOUR_PUBLISHED_WORKFLOW_UUID"
npx supabase secrets set DIDIT_ALLOWED_ORIGINS="https://donivra.vercel.app,http://localhost:3000"
```

For a Vercel preview that you intentionally want to test, add its exact origin to the comma-separated `DIDIT_ALLOWED_ORIGINS` value. Avoid broad wildcard origins because anyone reaching the function could consume your Didit verification quota.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are supplied automatically to deployed Supabase Edge Functions. Do not expose the service-role key to React.

## 5. Deploy the Edge Function

```powershell
npx supabase functions deploy didit-verification
```

The public form calls the function through the project's Supabase anonymous key. Keep normal JWT verification enabled. If the function returns `401`, first confirm that `REACT_APP_SUPABASE_ANON_KEY` belongs to the same linked Supabase project rather than disabling verification.

## 6. Run an end-to-end sandbox test

1. Start the web application with `npm start`.
2. Open `http://localhost:3000/apply-event`.
3. Accept the terms and click **Start ID Verification**.
4. Complete Didit's sandbox flow with an approved scenario/document allowed by your Didit sandbox Application.
5. Confirm all of the following:
   - The Didit status changes to **Approved**.
   - Only name, ID number, gender, address, and ID type fill the applicant fields.
   - The user can correct OCR text when needed.
   - The form cannot continue without an Approved Didit decision.
   - A submitted date appears in **Currently reserved** for a second browser/user.
   - A second submission covering that date is rejected even if both users submit at nearly the same time.
   - After staff changes the original application itself to **Rejected**, the date becomes available again.
   - The application row has an `Applicant_Valid_ID_Path` beginning with `verified-sessions/`.
   - Supabase Storage has the front image in the private `event_application_private_ids` bucket.
   - Staff and admin can open the private ID image through a short-lived signed link.

## 7. Move to production

1. Switch to the production Didit Application/API key if you used a separate sandbox Application.
2. Confirm the production workflow is published.
3. Set the production `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID`, and exact production origin again.
4. Redeploy `didit-verification`.
5. Run one real authorized verification and inspect it in **Didit Console → Sessions**.
6. Check the Edge Function logs in **Supabase Dashboard → Edge Functions → didit-verification → Logs**.

## How the security checks work

- The browser never receives the Didit API key or Supabase service-role key.
- Each verification session gets a random client token; only its SHA-256 hash is stored.
- Callback or iframe status values are treated only as hints. The Edge Function always retrieves the canonical decision from Didit.
- Only a session whose overall Didit status and ID Verification feature are both Approved can be attached to an application.
- A Didit session can be used for only one program application.
- Didit image URLs are temporary, so the Edge Function immediately copies only the verified front image into the private `event_application_private_ids` bucket. It never puts a government ID in the public program-photo bucket.
- PostgreSQL, not only the browser, prevents two non-rejected program applications from covering the same date.

## Relevant files

- `src/pages/public/EventApplicationPage.jsx` — embedded Didit flow, autofill, contact note, and date feedback.
- `supabase/functions/didit-verification/index.ts` — server-side Didit session creation and canonical decision retrieval.
- `supabase/143_program_date_and_didit_verification.sql` — trusted session storage, extracted fields, verification trigger, and concurrency-safe date reservation rule.
- `supabase/144_private_verified_id_front_and_same_day_programs.sql` — private front-ID storage, staff/admin access policy, and same-day schedule enforcement.
