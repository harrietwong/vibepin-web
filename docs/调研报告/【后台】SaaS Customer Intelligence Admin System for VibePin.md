# SaaS Customer Intelligence Admin System for VibePin

## Executive Summary

The strongest pattern across modern SaaS admin and support systems is not “show everything.” It is **show the few facts that answer the first support question immediately, then progressively disclose depth**. Intercom puts user and company context in the inbox side rail so an agent can see plan, last activity, browser, and custom business attributes without leaving the conversation. Zendesk does something similar with a context panel that surfaces the requester profile, recent interactions, pages viewed, and optional third-party profiles. Stripe centers the customer page on the objects support most often needs for revenue troubleshooting—subscriptions, payments, payment methods, invoices, and quotes. Mixpanel and Amplitude go deeper on debugging by pairing current user properties with exact event history. citeturn5view0turn6view0turn5view2turn6view2turn11view0

For VibePin, that means the right product is **not** a mini-Salesforce. It should be an **operator console** for founders and support: one customer list, one decisive customer detail page, one clean activity timeline, one error layer, and one billing snapshot. The page should answer six questions in the first screenful: **Who is this? Are they paying? Are they active? Are they succeeding? Are they blocked? Are they upset?** That approach follows the most useful parts of Intercom, Zendesk, Stripe, Mixpanel, and Amplitude without inheriting enterprise CRM complexity. citeturn5view0turn6view0turn5view2turn10view0turn11view0

The recommended VibePin design is therefore:

- a **Customer List** optimized for triage, not account management;
- a **Customer 360 page** with first-fold summary, reliability alerts, usage snapshot, billing snapshot, support snapshot, and a grouped event timeline;
- a **normalized error layer** that turns raw failures into readable customer problems;
- **Stripe as the billing source of truth**;
- a **lightweight feedback object** that merges support, NPS/CSAT, feature requests, and reviews;
- a **simple red/yellow/green health model** driven by activity, successful usage, billing, and friction.

That recommendation also matches broader admin patterns from Vercel, Linear, Canva, and OpenAI: operations are easier to manage when members, billing, usage, and governance are separated in navigation; risky actions are role-gated; and analytics/spend controls do not automatically expose sensitive underlying content. citeturn7view0turn5view5turn5view6turn7view5turn4search0turn4search1turn4search2turn13view0turn13view1turn13view2

## Competitive Analysis

Public docs do not expose every company’s internal-only support tooling, especially for Canva and AI SaaS. But the official admin, analytics, billing, and help-center surfaces are still enough to identify the structural patterns worth borrowing.

**Intercom Customer Profile.** Intercom shows customer and company details directly in the inbox’s right-hand column, including last activity, plan, company, browser, and custom conversation details. Opening the full profile reveals an “About” column with activity recency, language, sessions, custom attributes, tags, segments, notes, and event history; company profiles add company plan, spend, seat-like usage, last seen, and member lists. Support/admin actions include customizing visible fields, leaving notes, editing or deleting notes, and using custom attributes for segmentation. Sensitive information is handled through attribute controls: Intercom explicitly notes that attributes without authenticated-update protection can be open to insecure updates, and deleted notes are not recoverable. The design lesson for VibePin is strong first-fold context plus editable internal notes, but with careful protection around mutable attributes. citeturn5view0turn8view0turn8view1turn8view2

**Zendesk Customer Context.** Zendesk’s context panel is ticket-centric. Immediately visible are the user profile card, recent interactions, pages viewed, and—where enabled—device information and third-party profiles/events. More detail lives behind “view more details,” “view all,” or linked profile pages. The timeline is an interaction history of recent conversations, tickets, and related events; admins can also configure additional fields or integrated profiles. Agents can make basic profile updates, write profile-level notes, preview linked tickets, and jump into full records. Sensitive information is clearly permissioned: some roles cannot see device information, and third-party profile data is admin-controlled. The design lesson for VibePin is that support context should live *inside* the customer profile, but remain compact and role-aware. citeturn5view1turn6view0turn6view1

**Stripe Customer Dashboard.** Stripe’s customer page is one of the clearest examples of a revenue-oriented customer view. On the customer surface, support can see subscriptions, payments, payment methods, invoices, and quotes; the customer list also supports filtering by email, card status, creation date, account type, and delinquency status. Stripe’s data model exposes many sensitive billing facts—default payment method, addresses, preferred locales, tax and invoice settings, metadata, and credit balances—and Stripe recommends storing your internal customer ID in Stripe metadata to improve support and auditing. Stripe also exposes operational lifecycle details such as `trialing`, `active`, `paused`, and `past_due`; handles failed charges with retry tooling; and makes an important boundary explicit: draft invoices are editable, but finalized invoices are not. The design lesson for VibePin is to mirror Stripe status and history, but not recreate Stripe’s billing control plane inside your admin. citeturn5view2turn9view0turn9view1turn9view2turn9view3turn9view4turn9view5turn9view6

**Mixpanel User Profile.** Mixpanel treats user profiles as an optional layer on top of events and explicitly recommends starting with events first and adding user profiles only if needed. A user profile shows current user properties plus an Activity Feed that lists the user’s event history with the most recent event at the top. The profile activity feed also exposes the Identity Cluster, making it useful for debugging anonymous-to-authenticated identity stitching. Actions are mostly investigative rather than operational: search/validate profile properties, inspect events, confirm identity merges, and create cohorts. Sensitive information centers on identifiers and identity resolution; Mixpanel recommends stable internal IDs over mutable identifiers like email. The design lesson for VibePin is that events should be the core substrate and profile facts should stay lean and purpose-built. citeturn5view3turn6view2turn10view0turn10view1turn10view2

**Amplitude User Lookup.** Amplitude’s user profile is the most explicit example of progressive disclosure for debugging. The profile has two main sections—User Details and User History. User Details shows the most recent properties and allows teams to pin properties above the fold or move them below the fold; User History has six tabs: Activity, Insights, Session Replays, Cohorts, Experiments, and Flags. The event stream shows a user’s full event history, grouped by session, with current and event-time properties visible when an event is opened. Amplitude also complements this with org-wide audit logs that record who did what, when, from which IP, and any associated errors; the UI shows summary cards and search/sort, while the API exposes deeper metadata. The design lesson for VibePin is to combine a short current-state summary with a session-grouped history and a lightweight admin audit trail. citeturn11view0turn6view3turn11view1turn11view2turn3search2

**Vercel Team Dashboard.** Vercel is not a support CRM, but it is a strong model for internal operator navigation. Member management, access roles, billing, invoices, spend management, notifications, and usage are intentionally separated by sidebar navigation. Team owners can invite members, assign roles, adjust project access, manage spend thresholds, receive usage alerts, and even pause production deploys when spend caps are hit. Billing docs also make governance boundaries explicit: past invoices are visible, invoice changes apply only to future invoices, and billing roles are distinct from general member roles. The design lesson for VibePin is a clean split between Customers, Billing, and Operations rather than one overloaded admin page. citeturn5view5turn6view4turn6view5turn7view0turn7view1turn7view2turn7view3

**Linear Workspace and Members.** Linear’s admin model is also navigation-first. The Members page lists active and suspended users, supports filtering by role or status, and lets admins suspend users while preserving historical visibility for created/assigned work. Workspace settings expose login preferences, member management, billing updates, plan changes, and other administration controls. Linear also uses visibility boundaries such as private teams, where access is purposefully constrained and admins may need to explicitly join to access sensitive work. The design lesson for VibePin is to preserve historical customer context even after churn or suspension, and to keep sensitive customer data behind intentional access boundaries. citeturn5view6turn7view4turn7view5turn7view6

**Canva Creator and Customer Admin Patterns.** Canva’s public help surfaces emphasize team roles, billing, invoice history, AI usage tracking, AI passes/top-ups, and admin controls rather than a support-style customer 360 view. Public docs describe owner/admin/member roles, purchase history and invoices, AI usage trackers, AI passes, AI top-ups, and team-level payment method control. That tells us Canva’s exposed admin pattern is **settings-based**, not **customer-profile-based**. The design lesson for VibePin is not to copy Canva’s structure wholesale; use it mainly as proof that AI allowance and billing history are important, but they belong in compact product and billing modules inside a customer page rather than separate settings pages for founder support work. citeturn4search0turn4search1turn4search2turn4search5turn4search9turn4search16turn4search17

**AI SaaS Admin Pattern from OpenAI.** OpenAI’s current workspace admin model is helpful because it separates usage governance from private content. Workspace settings centralize members, feature access, spend controls, analytics, roles, and identity controls. Workspace analytics provides overview, benchmarks, impact, task insights, and user-level activity metrics; however, task insights are explicitly aggregated and do not expose individual prompts or chat content. Business spend controls are also explicit that usage limits are operational and do not grant access to a user’s private chat history. The design lesson for VibePin is important: show AI consumption, task outcomes, and reliability signals in admin, but do **not** default to exposing raw prompts, generated content, or private creative history unless the support job genuinely requires it and access is permissioned. citeturn6view8turn6view9turn13view0turn13view1turn13view2turn12search2

Across all of these systems, the reusable best practices are clear. First, the **immediate surface** is always identity + status + recent context. Second, **mutable business facts** and **append-only behavior history** are treated as different things. Third, the best systems use **progressive disclosure**: above-the-fold summary, then tabs, drawers, or deep links for detail. Fourth, risky actions—billing edits, access changes, privacy-sensitive logs—are **role-gated and source-of-truth-aware**. Fifth, newer AI/admin systems increasingly separate **usage visibility** from **private content visibility**, which VibePin should do from the start. citeturn5view0turn6view0turn9view4turn11view0turn13view0turn13view2

## Recommended VibePin Customer Profile Design

The VibePin Customer 360 page should be optimized for a **ten-second read** and a **two-minute debug**. The first screenful should look more like Intercom and Zendesk than like a BI dashboard: a strong identity block, a compact current-state summary, and obvious blockers. Then it should borrow Amplitude’s and Mixpanel’s debugging strengths for the timeline and Stripe’s discipline for billing detail. citeturn5view0turn6view0turn11view0turn10view0turn5view2

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Customer Header                                                             │
│ Ava Collins · ava@brand.com · usr_12345 · Signed up Mar 02, 2026           │
│ Plan: Pro  |  Status: Active  |  Health: Yellow  |  Last active: 14m ago   │
│ Pinterest: Connected  |  Stripe: customer_abc  |  Support owner: Founder    │
├──────────────────────────────────────────────────────────────────────────────┤
│ Alert Strip                                                                 │
│ [Publish failures in last 24h] [1 failed payment retry] [OAuth healthy]     │
├───────────────────────────────┬──────────────────────────────────────────────┤
│ Left Column                   │ Right Rail                                   │
│ Product snapshot              │ Billing snapshot                             │
│ Timeline                      │ Support snapshot                             │
│ Error timeline                │ Feedback + notes                             │
│ Usage history                 │ Safe actions + external deep links           │
└───────────────────────────────┴──────────────────────────────────────────────┘
```

The recommended module layout is below.

| Module | What to show | Why it belongs there |
|---|---|---|
| Customer Header | Name, email, user ID, signup date, current plan, account status, health chip, last active time, primary Pinterest status, Stripe customer ID, support owner | This is the “who/are they paying/are they alive” layer |
| Alert Strip | Unresolved publish failure, unresolved generation failure, billing past_due, Pinterest OAuth broken, schedule failure, credits exhausted, unusually high failure rate | This is the “are they blocked right now” layer |
| Product Snapshot | Total pins created, pins in last 7/30 days, AI generations, generation success rate, publish success rate, scheduled pins, boards imported, connected Pinterest accounts, current credit balance | This is the “are they using and succeeding” layer |
| Billing Snapshot | Current plan, MRR-equivalent, subscription status, trial status, renewal date, cancellation state, failed payment state, invoices count, last payment, credit purchases | This is the “are we getting paid and is commerce healthy” layer |
| Support Snapshot | Open ticket count, last conversation summary, last support issue, latest CSAT/NPS, average resolution time, escalation flag | This is the “are they frustrated” layer |
| Activity Timeline | Session-grouped customer events across product, billing, support, feedback, authentication, and integrations | This is the narrative layer |
| Error Timeline | Human-readable reliability incidents with severity, status, timestamps, related object, retry/resolution state | This is the debugging layer |
| Internal Notes | Admin-only notes and structured tags such as VIP, refund-risk, beta-user, creator-agency | This is the memory layer |
| Safe Actions | Grant bonus credits, add note, assign owner, open in Stripe, open support thread, resync external status, requeue safe retry | This is the “act without breaking accounting” layer |

**What should be visible immediately.** In the first fold, VibePin should always show: identity, plan, status, health, last active, Pinterest connection status, credit balance, current blockers, last payment state, and the most recent meaningful activity. That mirrors Intercom’s “plan/last active/custom attributes,” Zendesk’s requester context, and Amplitude’s pinned properties. It should not force a founder to click tabs just to learn whether a customer is paying, stuck, or inactive. citeturn5view0turn6view0turn11view0

**What should be hidden behind tabs or drawers.** Full invoice history, raw generation parameters, full event payloads, related board lists, all historical plan changes, all support threads, and all prior credit transactions should be accessible—but not first-fold. Stripe keeps detailed billing objects on deeper pages, Zendesk pushes expanded profile details behind a profile view, and Amplitude explicitly moves unpinned properties below the fold while using tabs for dense investigative surfaces. VibePin should follow the same rule. citeturn5view2turn6view0turn11view0

**Customer Activity Timeline.** The timeline should include only events that help support understand intent, value, or failure. That means logins, Pinterest connect/disconnect events, board imports, pin creations/edits, AI generation requested/succeeded/failed, publish requested/succeeded/failed, schedule created/executed/failed, plan changes, credit grants/uses, invoice paid/failed, support conversations, feedback submission, and NPS/CSAT responses. By default, group the feed by **session** or **work chunk**. Amplitude’s user history groups events by session, while Mixpanel and Intercom show recent activity in chronological order with the newest events at the top. VibePin should combine both ideas: chronological by default, but grouped into meaningful bursts such as “Created and published 3 pins from Board X.” citeturn6view3turn10view0turn8view0

Noise reduction matters more than completeness. The default timeline should **collapse retries**, **aggregate bursts**, and **hide low-signal telemetry** such as minor page views, heartbeat pings, or repeated internal polling. Zendesk’s interaction history is useful because it surfaces recent relevant interactions, not every backend event; Mixpanel is helpful because it can show exact events when a debugger needs them. So VibePin should have two modes: **Customer Timeline** for humans and **Raw Event Debug** for engineers. citeturn6view0turn10view0turn11view0

**Error Intelligence.** Support should be able to answer the user’s specific operational questions immediately: when was the last failed publish, last failed AI generation, billing failure, Pinterest OAuth failure, failed scheduled task, or credits issue? The best way to do that is a dedicated **Current Problems** block above the timeline plus a **Customer Error Timeline** below it. Each error card should normalize the raw failure into a readable incident:

| Error card | Required fields |
|---|---|
| Publishing Failure | First seen, last seen, affected pin, board, Pinterest account, human-readable cause, raw error code, retry count, current status, linked resolution event |
| AI Generation Failure | First seen, last seen, generation type, model/provider, credit impact, human-readable cause, raw error code, current status |
| Billing Failure | Invoice ID, amount, Stripe status, retry status, next attempt, current status |
| Pinterest OAuth Failure | First seen, last seen, account affected, token state, reconnect needed, current status |
| Schedule Failure | Scheduled time, job ID, related pin, failure cause, current status |
| Credit Issue | Requested cost, available credits, plan allowance, current status |

This follows the investigative style of Amplitude and Mixpanel, which expose event-time properties for individual failures, and Zendesk’s approach of pulling third-party events into customer context. citeturn6view3turn10view0turn6view1

**Support Integration.** Yes—support tickets should appear inside the customer profile, but as a **summary module**, not as a full replacement for your ticketing system. Zendesk and Intercom both demonstrate that support context belongs next to customer identity and recent behavior. VibePin should show previous conversations, AI summaries, last support issue, CSAT/NPS, resolution time, owner, and any linked product errors. The founder should be able to scan the last three interactions, understand what the customer already said, and then deep-link into the full conversation in the actual support tool. citeturn5view0turn6view0

**UI and UX recommendations.** Keep the page to at most one fixed sticky header, one alert strip, and a two-column body. Avoid tab explosion. Use color only for obvious states such as health or unresolved blockers. Add a universal timeline filter with chips such as **All**, **Product**, **Errors**, **Billing**, **Support**, and **Feedback**. Use copyable IDs everywhere. Add “open in Stripe,” “open support thread,” and “open raw logs” deep links on the right rail. In P1, add customizable pinned fields, following the Intercom/Amplitude pattern of configurable visible context. citeturn5view0turn11view0

## Data Model and Event Architecture

VibePin should adopt a deliberately simple internal model built around **facts, state, and events**. That matches the clearest patterns from Intercom, Mixpanel, and Amplitude: custom/user attributes describe slowly changing customer facts; events describe recurring actions; user details surfaces show the most recent properties while history surfaces show the sequence of actions. Mixpanel even recommends starting with events and adding profiles only if necessary. citeturn8view1turn5view3turn11view0turn3search2

The practical implication is:

- **Facts**: user/account data that changes occasionally;
- **State**: derived current condition such as current plan, current health, current Pinterest status, latest blocker;
- **Events**: immutable time-series records of what happened;
- **Incidents**: normalized error/problem records created from certain event patterns.

Stripe also recommends storing your internal customer ID as metadata on the Stripe customer resource to improve support and searchability, while Mixpanel’s identity guidance shows why VibePin should preserve both stable authenticated IDs and any anonymous/pre-auth identifiers for debugging. citeturn9view5turn10view2

The recommended core data model is below.

| Object | Purpose | Key fields |
|---|---|---|
| `users` | Canonical customer record | `id`, `email`, `name`, `created_at`, `status`, `timezone`, `country`, `last_active_at` |
| `customer_summary` | Denormalized current-state record for fast admin reads | `user_id`, `plan`, `billing_status`, `health_score`, `health_band`, `current_credit_balance`, `pinterest_status`, `last_publish_at`, `last_generation_at`, `open_ticket_count`, `last_error_at`, `risk_flags_json` |
| `pinterest_accounts` | Connected external accounts | `id`, `user_id`, `pinterest_user_id`, `status`, `connected_at`, `last_refresh_at`, `last_error_at` |
| `boards` | Imported Pinterest boards | `id`, `user_id`, `pinterest_account_id`, `external_board_id`, `name`, `sync_status`, `last_synced_at` |
| `pins` | Pin entities in VibePin | `id`, `user_id`, `board_id`, `status`, `created_at`, `updated_at`, `scheduled_for`, `published_at` |
| `ai_jobs` | AI generation jobs | `id`, `user_id`, `pin_id`, `job_type`, `provider`, `status`, `requested_credits`, `consumed_credits`, `started_at`, `completed_at`, `error_id` |
| `publish_jobs` | Publish attempts | `id`, `user_id`, `pin_id`, `pinterest_account_id`, `status`, `attempted_at`, `completed_at`, `error_id` |
| `schedule_jobs` | Scheduled publish execution | `id`, `user_id`, `pin_id`, `scheduled_for`, `status`, `executed_at`, `error_id` |
| `subscriptions` | Current and historical subscription states | `id`, `user_id`, `stripe_customer_id`, `stripe_subscription_id`, `plan`, `status`, `billing_cycle`, `trial_ends_at`, `renews_at`, `cancels_at` |
| `payments` | Invoice/payment history mirror from Stripe | `id`, `user_id`, `stripe_invoice_id`, `stripe_payment_intent_id`, `amount`, `currency`, `status`, `paid_at`, `failed_at`, `refunded_at` |
| `credit_ledger` | Every credit movement | `id`, `user_id`, `type`, `source`, `amount`, `balance_after`, `reference_type`, `reference_id`, `reason`, `created_at`, `created_by_admin_id` |
| `support_threads` | Conversation/ticket summary | `id`, `user_id`, `source_system`, `external_id`, `status`, `owner_id`, `opened_at`, `closed_at`, `csat_score`, `summary_text` |
| `feedback_items` | Unified product feedback object | `id`, `user_id`, `source`, `category`, `message`, `sentiment`, `feature_area`, `status`, `votes`, `ticket_id`, `conversation_id`, `admin_notes`, `created_at` |
| `customer_events` | Canonical append-only timeline | `id`, `user_id`, `event_name`, `event_category`, `session_id`, `occurred_at`, `entity_type`, `entity_id`, `success`, `properties_json` |
| `error_incidents` | Normalized customer-relevant failures | `id`, `user_id`, `error_type`, `severity`, `status`, `first_seen_at`, `last_seen_at`, `latest_event_id`, `affected_entity_type`, `affected_entity_id`, `human_summary`, `raw_code`, `resolution_event_id` |
| `customer_health_daily` | Stored daily health snapshots | `id`, `user_id`, `date`, `score`, `band`, `drivers_json` |
| `admin_notes` | Lightweight memory layer | `id`, `user_id`, `author_id`, `note_type`, `body`, `created_at` |
| `admin_audit_log` | Internal admin traceability | `id`, `actor_id`, `action`, `target_type`, `target_id`, `metadata_json`, `created_at`, `ip_address` |

The event taxonomy should stay narrow and human-readable from the start.

| Event namespace | Example events | Core properties |
|---|---|---|
| `account.*` | `account.signed_up`, `account.logged_in`, `account.profile_updated` | device, auth_method, country |
| `pinterest.*` | `pinterest.connected`, `pinterest.refresh_failed`, `pinterest.disconnected` | account_id, external_user_id, error_code |
| `board.*` | `board.import_started`, `board.import_completed`, `board.import_failed` | board_id, pin_count, duration_ms |
| `pin.*` | `pin.created`, `pin.edited`, `pin.deleted` | pin_id, board_id |
| `ai.*` | `ai.image_requested`, `ai.image_succeeded`, `ai.image_failed`, `ai.copy_requested`, `ai.copy_failed` | job_id, provider, prompt_template, credits_used, latency_ms, error_code |
| `publish.*` | `publish.requested`, `publish.succeeded`, `publish.failed` | job_id, pin_id, pinterest_account_id, latency_ms, error_code |
| `schedule.*` | `schedule.created`, `schedule.executed`, `schedule.failed`, `schedule.canceled` | schedule_id, pin_id, scheduled_for |
| `billing.*` | `billing.trial_started`, `billing.subscription_started`, `billing.plan_changed`, `billing.invoice_paid`, `billing.invoice_failed`, `billing.refund_issued` | stripe IDs, amount, currency, plan_from, plan_to |
| `credits.*` | `credits.granted`, `credits.used`, `credits.expired`, `credits.refunded` | amount, balance_after, source |
| `support.*` | `support.conversation_opened`, `support.ticket_created`, `support.ticket_closed`, `support.csat_received` | source_system, external_id, score |
| `feedback.*` | `feedback.submitted`, `feedback.voted`, `feedback.status_changed` | source, category, feature_area |

The API surface should be internal and intentionally conservative.

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /admin/customers` | Search/filter customer list | Filter by plan, health, billing state, Pinterest state, last active, failure flags |
| `GET /admin/customers/{id}` | Full Customer 360 payload | Returns header, summary, current blockers, support snapshot |
| `GET /admin/customers/{id}/timeline` | Grouped activity feed | Supports filters by category and date range |
| `GET /admin/customers/{id}/errors` | Error incidents + recent raw failure events | Separate current/open from historical/resolved |
| `GET /admin/customers/{id}/billing` | Subscription, invoices, payments, credits | Stripe mirror only |
| `GET /admin/customers/{id}/feedback` | Unified feedback feed | Links to support and roadmap objects |
| `GET /admin/customers/{id}/health` | Current score + driver breakdown | Must return top positive and negative drivers |
| `POST /admin/customers/{id}/notes` | Add internal note | Safe write |
| `POST /admin/customers/{id}/credits/grants` | Grant bonus/manual credits | Require reason + audit log entry |
| `POST /admin/customers/{id}/owner` | Assign support owner | Safe write |
| `POST /admin/customers/{id}/resync` | Trigger resync for Stripe/Pinterest summaries | Safe operational action |
| `POST /internal/events/ingest` | Capture event stream | Append-only |
| `POST /internal/webhooks/stripe` | Stripe source-of-truth sync | Required for billing state |
| `POST /internal/webhooks/pinterest` | OAuth/publish callbacks | Required for integration state |

**Privacy and sensitive data.** VibePin should explicitly separate **operational context** from **sensitive content**. Stripe-borne data such as payment methods, addresses, tax information, invoice settings, and credit balances is sensitive and should be mostly read-only in VibePin. Zendesk’s device visibility restrictions and OpenAI’s separation between spend controls/analytics and private chat visibility are useful models here. For AI workflows, default to showing job metadata, status, latency, and error summaries—not raw prompts or generated assets—unless a support user has elevated debug access. Add an admin audit log that records who granted credits, added notes, changed owners, or retried jobs, following the spirit of Amplitude’s audit log. citeturn9view0turn9view5turn6view0turn13view0turn13view2turn11view2

## Billing, Feedback, and Health

The right billing design for VibePin is **mirror, summarize, and deep-link**. Stripe’s customer and subscription model already covers subscriptions, payment methods, invoice lifecycles, failures, retries, and customer self-service. Vercel, Canva, and OpenAI all similarly separate billing views from the rest of product operations and restrict who can manage them. So VibePin should keep Stripe as the source of truth and expose only the information support actually needs, plus a very small set of safe actions. citeturn5view2turn9view1turn9view3turn9view4turn7view1turn4search1turn13view1turn13view2

The recommended billing view is below.

| Area | Show to admins | Allow to modify in VibePin | Do not modify in VibePin |
|---|---|---|---|
| Subscription | Current plan, previous plans, billing cycle, trial status, renewal date, cancellation date, Stripe subscription ID, status timeline | Assign internal billing note, open Stripe, trigger resync | Direct plan swaps, backdated billing edits, subscription state overrides |
| Payments | Invoice history, payment status, failed payments, refunds, last successful payment, next retry | Open invoice in Stripe, mark internal follow-up owner | Edit finalized invoices, alter payment amounts, edit tax records |
| Credits | Purchased credits, used credits, expired credits, bonus credits, refund credits, full credit ledger | Grant bonus/manual courtesy credits with reason and audit log | Delete historical ledger rows, silently reduce balances |
| Payment method | Brand, last4, expiry month/year, billing country if needed | Open Stripe customer/payment method page | Full PAN, CVV, raw vault data |
| Billing identity | Stripe customer ID, preferred locale, tax state if truly necessary | Copy IDs, resync | Rewrite Stripe identifiers |

A separate “orders” system is usually unnecessary for an early-stage SaaS unless you introduce true one-off carts or multi-line purchases. If VibePin only has recurring plans and optional one-time credit packs, treat the commercial model as **subscription + payments + credit ledger**, not as a full commerce order engine. Stripe’s data model already supports customer credit balance and invoice/payment lifecycles; duplicating that with an internal order abstraction would add complexity without much operational value. citeturn9view2turn9view5

The feedback system should be **multi-source but single-object**. The best feedback tools do three things well: collect feedback close to the moment of friction, attach it to the right user/customer, and close the loop when status changes. Productboard’s feedback forms and insights model attach feedback to specific customers and route it to the right product owners; Canny emphasizes votes, status changes, and notifications to voters; Zendesk CSAT captures satisfaction on support interactions; Intercom’s NPS guidance highlights that survey work should produce action, not vanity scores. citeturn15search7turn16search11turn16search14turn16search19turn15search0turn16search3turn16search6turn15search10turn15search22turn15search5

VibePin’s feedback sources should be:

| Source | Why it matters |
|---|---|
| Support conversations | Captures friction at the moment of pain |
| In-app feedback button | Captures unsolicited product ideas and complaints |
| Feature request board/form | Captures roadmap demand and votes |
| NPS/CSAT surveys | Captures sentiment and support experience |
| Review request flows | Captures public advocacy or dissatisfaction |
| Manual founder entry | Lets support attach verbal feedback from calls or emails |

The feedback object should be simple and durable.

| Field | Purpose |
|---|---|
| `id` | Stable feedback ID |
| `user_id` | Link to customer |
| `source` | Support, widget, NPS, CSAT, review, email, manual |
| `category` | Bug, feature request, usability, billing, onboarding, AI quality, publish reliability |
| `message` | Original feedback body |
| `summary` | AI-generated short summary |
| `sentiment` | Positive, neutral, negative, mixed |
| `feature_area` | Pins, AI images, AI copy, Publishing, Scheduling, Billing, Credits, Boards |
| `status` | New, triaged, under review, planned, shipped, closed-no-plan |
| `votes` | Demand count if applicable |
| `related_ticket_id` | Link to support issue |
| `related_error_id` | Link to error incident |
| `admin_notes` | Product/support notes |
| `owner_id` | Responsible person |
| `last_contacted_at` | Closing-the-loop record |
| `created_at` / `updated_at` | Lifecycle tracking |

The health system should stay intentionally simple. Gainsight and Planhat both describe health score as a composite signal that blends product usage, support history, sentiment, and business signals, often displayed as red/yellow/green; they also emphasize that the model should fit the business rather than chase generic complexity. citeturn14search0turn14search1turn14search5turn14search6turn14search8turn14search16

For VibePin, a practical first model is:

| Signal | Rule | Weight |
|---|---|---|
| Recent activity | Active within 7 days | +20 |
| Publishing success | At least 1 successful publish in last 14 days | +20 |
| AI usage | Meaningful generation activity in last 14 days | +10 |
| Pinterest connected | Healthy connected account present | +10 |
| Credit utilization | Using credits in a normal range, not zero forever and not hard-blocked | +10 |
| Support sentiment | Positive/no recent negative support interaction | +10 |
| Billing health | Subscription active and not past_due | +10 |
| Schedule reliability | No recent schedule failures | +10 |
| Inactivity penalty | No login for 14+ days | -20 |
| Publish failure penalty | Publish failure rate above threshold in last 7 days | -20 |
| AI failure penalty | Generation failure rate above threshold in last 7 days | -15 |
| OAuth penalty | Pinterest disconnected or refresh failing | -20 |
| Billing penalty | Failed payment/past_due | -30 |
| Negative support penalty | Repeated complaints/poor CSAT in last 30 days | -15 |

Recommended banding:

| Band | Score | Meaning |
|---|---|---|
| Green | 70–100 | Customer is active, succeeding, and commercially healthy |
| Yellow | 40–69 | Warning signs; check friction, reliability, or onboarding |
| Red | 0–39 | Immediate intervention needed |
| Override rule | Any unresolved billing failure or broken Pinterest connection on an otherwise active customer | Force at most Yellow, sometimes Red |

A useful extra refinement is to keep one visible band but compute the score through **plan-aware rules**. Free users are usually an activation problem, while paid users are a retention/reliability problem. So in P0, show one universal band; in P2, branch the logic by lifecycle stage.

## Admin Navigation, Roadmap, and Risks

Modern admin systems work better when the navigation matches the mental model of the operator. Vercel separates members, billing, invoices, usage, and notifications. Linear separates workspace administration, members, billing, and private visibility controls. OpenAI similarly separates workspace settings, analytics, billing, usage limits, identity, and roles. VibePin should follow that same “clear domains, shallow hierarchy” pattern. citeturn5view5turn7view1turn7view5turn5view6turn13view0turn13view1turn6view8

Recommended navigation:

```text
Overview
├── System Overview
├── Platform Health
└── Critical Alerts

Customers
├── Customer List
├── Customer Detail
├── Segments
└── Customer Health

Billing
├── Subscriptions
├── Payments
├── Credits
└── Failed Billing

Support
├── Conversations
├── Tickets
├── Feedback
└── Satisfaction

Operations
├── Generation Logs
├── Publish Failures
├── Schedule Failures
└── Integration Errors

Insights
├── Creative Intelligence
├── Product Usage
└── Feedback Trends
```

The **Customer List** deserves special attention. It should be the founder’s triage board, with columns for user, plan, health, last active, publish success rate, failure flags, current credits, Pinterest status, open ticket count, and MRR-equivalent. Filters should include plan, status, health, inactivity, billing issue, OAuth issue, publish failure, AI failure, and support sentiment.

The recommended scope split is below.

| Feature | Scope | User value | Founder/support value | Engineering complexity | Maintenance cost | Recommendation |
|---|---|---:|---:|---:|---:|---|
| Customer list with search/filters | P0 | High | High | Medium | Low | Mandatory starting point |
| Customer 360 header and product snapshot | P0 | High | High | Medium | Low | Mandatory |
| Billing snapshot + Stripe deep links | P0 | Medium | High | Low | Low | Mandatory |
| Credits ledger | P0 | Medium | High | Medium | Low | Mandatory |
| Activity timeline | P0 | High | High | Medium | Medium | Mandatory but grouped, not raw |
| Current problems / error cards | P0 | High | High | Medium | Medium | Mandatory |
| Support summary inside customer profile | P0 | High | High | Medium | Medium | Mandatory if support exists |
| Internal notes and owner assignment | P0 | Medium | High | Low | Low | Mandatory |
| Health score band + driver breakdown | P0 | Medium | High | Medium | Medium | Keep simple |
| Full raw event inspector | P1 | Low | Medium | Medium | Medium | Useful after launch |
| Feedback inbox with statuses/votes | P1 | Medium | High | Medium | Medium | Important for product learning |
| Segments and saved views | P1 | Medium | High | Medium | Low | Useful once customer count grows |
| Retry/requeue safe actions | P1 | Medium | Medium | Medium | Medium | Only for idempotent jobs |
| Configurable pinned fields | P1 | Low | Medium | Medium | Low | Nice, not launch-critical |
| Trend reporting for health/feedback/errors | P1 | Low | High | Medium | Medium | Build after basic workflows work |
| Role-based field visibility | P2 | Low | Medium | High | Medium | Only after team scales |
| Multiple health models by segment | P2 | Medium | Medium | Medium | Medium | Valuable later |
| Public feature-request portal with close-the-loop automation | P2 | Medium | Medium | Medium | Medium | Good if volume justifies it |
| Full embedded ticketing workflow | P2 | Low | Low | High | High | Avoid unless replacing a real support tool |
| Full CRM/account hierarchy/opportunities | Never | Low | Low | High | High | Do not build |

The main risks and the things not to build are just as important as the feature list.

| Risk or anti-pattern | Why it is dangerous | Better choice |
|---|---|---|
| Building a CRM instead of an operator console | Bloats scope with pipeline/account-management features VibePin does not need | Keep focus on support, debugging, revenue context |
| Showing every telemetry event in the default timeline | Makes the page unreadable | Group sessions, collapse retries, hide low-signal events |
| Rebuilding Stripe inside admin | Creates duplicate billing truth and compliance risk | Mirror Stripe, deep-link for risky actions |
| Letting admins edit historical billing rows or credit history silently | Breaks auditability and trust | Use append-only adjustments with reasons |
| Over-exposing raw AI prompts and generated content | Creates privacy and support-risk issues | Show metadata by default, gated debug access only |
| Creating a separate “orders” abstraction too early | Adds conceptual overhead without real benefit | Use subscription + payments + credit ledger |
| Adding heavy permissions before the team needs them | Slows shipping and complicates maintenance | Start with a very small admin/support split |
| Shipping a fancy health score with weak signal quality | Produces false confidence | Start with few signals and visible drivers |
| Building too many dashboards | Fragments context | Put customer-level truth in the Customer 360 page |
| Making support live in a separate universe from product events | Forces slow cross-tool debugging | Embed support summaries and linked errors in the profile |

The final recommendation is straightforward: **ship one excellent customer page before building any more analytics surfaces**. If VibePin can let the founder open a user and understand identity, value, blockers, support history, and billing state in one screen, it will already have the foundation most early-stage SaaS products wish they had.