/**
 * test-schedule-social-guard.ts — the stopgap that stops a multi-platform
 * Schedule from being silently reduced to Pinterest.
 *
 * Background: a merchant can tick Pinterest + Instagram + Facebook and press
 * Schedule. The Instagram/Facebook choice is never persisted (it lives only in
 * React state) and the due-time worker is Pinterest-only, so at due time only
 * Pinterest publishes — with no error and no trace of the original intent.
 *
 * Until scheduled destination intent is actually stored, scheduling to those
 * platforms is REFUSED rather than accepted and dropped. Publish now is
 * deliberately untouched: it dispatches immediately, so nothing needs to
 * survive until later.
 *
 * Run: npx tsx scripts/test-schedule-social-guard.ts
 */
import {
  PLATFORMS,
  canSchedule,
  unschedulableDestinations,
  type SocialProvider,
} from "../src/lib/social/platforms";
import {
  blockedScheduleDestinations,
  requestedSocialDestinations,
} from "../src/app/api/pin-drafts/promote";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
}
function section(t: string) { console.log(`\n=== ${t} ===`); }

// ── the capability rule itself ───────────────────────────────────────────────
section("scheduling capability is separate from publishing capability");

check("Pinterest can be scheduled", canSchedule("pinterest"));
check("Instagram cannot be scheduled (intent is not persisted yet)", !canSchedule("instagram"));
check("Facebook cannot be scheduled (intent is not persisted yet)", !canSchedule("facebook"));
check("TikTok cannot be scheduled (no publish path at all)", !canSchedule("tiktok"));

// The whole point of the stopgap: publish-now capability must NOT be reduced.
check("Instagram is still publishable now", PLATFORMS.instagram.liveConnect,
  "liveConnect must stay true — the hotfix only limits FUTURE-dated publishing");
check("Facebook is still publishable now", PLATFORMS.facebook.liveConnect);
check("Pinterest is still publishable now", PLATFORMS.pinterest.liveConnect);

// A platform that cannot be published to at all can never be schedulable —
// otherwise we would accept a schedule we could not execute even at due time.
section("no platform is schedulable without being publishable");
for (const p of Object.keys(PLATFORMS) as SocialProvider[]) {
  if (canSchedule(p)) {
    check(`${p}: schedulable ⇒ publishable`, PLATFORMS[p].liveConnect,
      `${p} has liveSchedule=true but liveConnect=false`);
  }
}

// ── the selection helper the UI and the API both call ────────────────────────
section("unschedulableDestinations reports exactly what must be refused");

check("Pinterest-only selection is allowed",
  unschedulableDestinations(["pinterest"]).length === 0);
check("Pinterest + Instagram is refused, naming Instagram",
  JSON.stringify(unschedulableDestinations(["pinterest", "instagram"])) === JSON.stringify(["instagram"]));
check("Pinterest + Facebook is refused, naming Facebook",
  JSON.stringify(unschedulableDestinations(["pinterest", "facebook"])) === JSON.stringify(["facebook"]));
check("all three refused, naming both non-Pinterest platforms",
  JSON.stringify(unschedulableDestinations(["pinterest", "instagram", "facebook"]))
    === JSON.stringify(["instagram", "facebook"]));
check("an empty selection is allowed (nothing to drop)",
  unschedulableDestinations([]).length === 0);

// The refusal must never quietly become a filter — the caller has to see the
// blocked entries, not a silently shortened list.
section("the helper reports, it does not silently filter");
const requested: SocialProvider[] = ["pinterest", "instagram", "facebook"];
const blocked = unschedulableDestinations(requested);
check("the input selection is left untouched",
  JSON.stringify(requested) === JSON.stringify(["pinterest", "instagram", "facebook"]),
  "unschedulableDestinations must not mutate its argument");
check("blocked entries are returned rather than removed from the selection",
  blocked.length === 2 && requested.length === 3);

// ── regression guard on the silent-drop shape itself ─────────────────────────
section("the exact silent-drop scenario is now detectable");
// Before the stopgap this selection was accepted and reduced to Pinterest with
// no signal at all. The test asserts we can now DETECT it; the drawer and the
// API route both turn this into a visible refusal.
const merchantPicked: SocialProvider[] = ["pinterest", "instagram", "facebook"];
const wouldSilentlyPublish = merchantPicked.filter(canSchedule);
check("a 3-platform schedule would really have collapsed to Pinterest",
  JSON.stringify(wouldSilentlyPublish) === JSON.stringify(["pinterest"]));
check("and that collapse is now flagged instead of accepted",
  unschedulableDestinations(merchantPicked).length > 0);

// -- the SERVER rule, on the payload shapes the route really receives --------
// The PUT route requires a real bearer token and has no test bypass (adding one
// was explicitly out of bounds), so the rule is asserted here directly. The route
// calls this same exported function, which is what makes this a server test and
// not a re-test of the UI helper.
section("server rule: only a SCHEDULED payload is restricted");

check("a scheduled 3-platform payload is blocked, naming IG+FB",
  JSON.stringify(blockedScheduleDestinations({
    scheduledDate: "2099-01-01", scheduledTime: "10:00",
    socialDestinations: ["pinterest", "instagram", "facebook"],
  })) === JSON.stringify(["instagram", "facebook"]));

check("a scheduled Pinterest-only payload passes",
  blockedScheduleDestinations({
    scheduledDate: "2099-01-01", scheduledTime: "10:00", socialDestinations: ["pinterest"],
  }).length === 0);

// This is the Publish-now shape: no date at all. It must be left completely alone.
check("an UNSCHEDULED payload with IG+FB is NOT blocked (publish now untouched)",
  blockedScheduleDestinations({
    socialDestinations: ["pinterest", "instagram", "facebook"],
  }).length === 0);

check("a scheduled payload naming no destinations passes",
  blockedScheduleDestinations({ scheduledDate: "2099-01-01", scheduledTime: "10:00" }).length === 0);

// plannedAt is the studio store's authority field and scheduledDate is the
// fallback. Both must trigger the rule, or one entry point silently escapes it.
check("plannedAt (not just scheduledDate) also counts as scheduled",
  blockedScheduleDestinations({
    plannedAt: "2099-01-01T10:00", socialDestinations: ["instagram"],
  }).length === 1,
  "a payload scheduled via plannedAt must be restricted too");

section("server rule: malformed input cannot slip through");
check("non-array socialDestinations is treated as empty",
  requestedSocialDestinations({ socialDestinations: "instagram" }).length === 0);
check("unknown provider strings are discarded",
  JSON.stringify(requestedSocialDestinations({
    socialDestinations: ["pinterest", "myspace", 42, null],
  })) === JSON.stringify(["pinterest"]));
check("a bogus provider cannot smuggle itself into a schedule",
  blockedScheduleDestinations({
    scheduledDate: "2099-01-01", socialDestinations: ["myspace"],
  }).length === 0);

// -- the row's visible state: disabled, but never hidden or "Not connected" ---
// Mirrors DestinationRow's own derivation (PublishDestinations.tsx). The stopgap
// must reduce SELECTABILITY only: the account is genuinely connected, so hiding
// the row or relabelling it "Not connected" would both misinform the merchant.
section("schedule mode disables selection without hiding or lying");

function rowState(provider: SocialProvider, connected: boolean, scheduleMode: boolean) {
  const meta = PLATFORMS[provider];
  const publishable = connected && meta.liveConnect;
  const blockedForSchedule = scheduleMode && publishable && !meta.liveSchedule;
  return {
    rendered: true,                        // the row is always rendered
    publishable,
    blockedForSchedule,
    actionable: publishable && !blockedForSchedule,
    readsAsConnected: publishable,         // status copy stays "Connected"-derived
  };
}

const igSched = rowState("instagram", true, true);
check("Instagram row is still rendered while scheduling", igSched.rendered);
check("Instagram is NOT selectable while scheduling", !igSched.actionable);
check("Instagram still reads as connected (not 'Not connected')", igSched.readsAsConnected);
check("Instagram is flagged specifically as schedule-blocked", igSched.blockedForSchedule);

const fbSched = rowState("facebook", true, true);
check("Facebook is not selectable while scheduling", !fbSched.actionable);
check("Facebook still reads as connected", fbSched.readsAsConnected);

const pinSched = rowState("pinterest", true, true);
check("Pinterest stays fully selectable while scheduling", pinSched.actionable);
check("Pinterest is never schedule-blocked", !pinSched.blockedForSchedule);

// Publish now (scheduleMode = false): nothing may be restricted.
const igNow = rowState("instagram", true, false);
const fbNow = rowState("facebook", true, false);
check("Instagram IS selectable for publish now", igNow.actionable);
check("Facebook IS selectable for publish now", fbNow.actionable);
check("no platform is schedule-blocked outside schedule mode",
  !igNow.blockedForSchedule && !fbNow.blockedForSchedule);

// A disconnected account must keep its real state — the stopgap must not make a
// not-connected platform look merely "temporarily unavailable".
const igOff = rowState("instagram", false, true);
check("a DISCONNECTED Instagram is not mislabelled as schedule-blocked",
  !igOff.blockedForSchedule && !igOff.readsAsConnected);

console.log(`\nSchedule social guard: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
