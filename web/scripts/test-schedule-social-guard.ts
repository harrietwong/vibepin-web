/**
 * test-schedule-social-guard.ts — the stopgap that stops a multi-platform
 * Schedule from being silently reduced to Pinterest.
 *
 * Background: a merchant can tick Pinterest + Instagram + Facebook and press
 * Schedule. The Instagram/Facebook choice is never persisted (it lives only in
 * React state) and the due-time worker is Pinterest-only, so at due time only
 * Pinterest publishes — with no error and no trace of the original intent.
 *
 * Intent is now stored on the draft and fanned out at due time, so the gate is
 * open for every platform we can publish to.
 *
 * The gate itself still matters and is still tested here: it is the single
 * capability switch (`liveSchedule`) and the single validation both the UI and
 * the API route consult. Flipping one entry to false is the entire rollback for
 * that platform's scheduling - no data migration - so the machinery must keep
 * working even while nothing is currently blocked.
 *
 * Run: npx tsx scripts/test-schedule-social-guard.ts
 */
import { readFileSync } from "node:fs";
import {
  PLATFORMS,
  canSchedule,
  unschedulableDestinations,
  type SocialProvider,
} from "../src/lib/social/platforms";
import {
  blockedScheduleDestinations,
  requestedSocialDestinations,
  requiredScheduleConnectionIds,
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
check("Instagram can be scheduled (intent is persisted and fanned out)", canSchedule("instagram"));
check("Facebook can be scheduled (intent is persisted and fanned out)", canSchedule("facebook"));
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
check("the three publishable platforms are ALL schedulable now",
  unschedulableDestinations(["pinterest", "instagram", "facebook"]).length === 0);
check("a platform with no publish path is still refused",
  JSON.stringify(unschedulableDestinations(["pinterest", "tiktok"])) === JSON.stringify(["tiktok"]));
check("an empty selection is allowed (nothing to drop)",
  unschedulableDestinations([]).length === 0);

// The refusal must never quietly become a filter — the caller has to see the
// blocked entries, not a silently shortened list.
section("the helper reports, it does not silently filter");
const requested: SocialProvider[] = ["pinterest", "tiktok", "instagram"];
const blocked = unschedulableDestinations(requested);
check("the input selection is left untouched",
  JSON.stringify(requested) === JSON.stringify(["pinterest", "tiktok", "instagram"]),
  "unschedulableDestinations must not mutate its argument");
check("blocked entries are returned rather than removed from the selection",
  blocked.length === 1 && requested.length === 3);

// -- the defect this whole line of work existed to kill -----------------------
section("a multi-platform schedule no longer collapses to Pinterest");
const merchantPicked: SocialProvider[] = ["pinterest", "instagram", "facebook"];
check("nothing in a 3-platform schedule is refused any more",
  unschedulableDestinations(merchantPicked).length === 0);
check("all three survive as schedulable destinations",
  merchantPicked.filter(canSchedule).length === 3,
  "if this drops below 3, a scheduled Pin silently loses platforms again");

// -- the SERVER rule, on the payload shapes the route really receives --------
// The PUT route requires a real bearer token and has no test bypass (adding one
// was explicitly out of bounds), so the rule is asserted here directly. The route
// calls this same exported function, which is what makes this a server test and
// not a re-test of the UI helper.
//
// THE PAYLOAD SHAPE MATTERS AND IS THE POINT: intent lives in
// `scheduledDestinations[]` ({provider, socialConnectionId, capturedAt}) — the only
// field anything persists or replays. The rule used to read `payload.socialDestinations`,
// which NOTHING writes (the drawer's socialDestinations is local React state), so it
// returned [] for every request ever made and the route's 422 could not fire at all.
section("server rule: only a SCHEDULED payload is restricted");

const AT = "2026-08-27T00:00:00.000Z";
/** Intent entries as the client really persists them — one account per provider. */
function intent(...providers: string[]) {
  return providers.map((provider, i) => ({
    provider, socialConnectionId: `conn-${i}`, capturedAt: AT,
  }));
}
const SCHEDULED = { scheduledDate: "2099-01-01", scheduledTime: "10:00" };

check("a scheduled 3-platform payload is accepted",
  blockedScheduleDestinations({
    ...SCHEDULED, scheduledDestinations: intent("pinterest", "instagram", "facebook"),
  }).length === 0);
check("a scheduled payload naming a non-publishable platform is still refused",
  JSON.stringify(blockedScheduleDestinations({
    ...SCHEDULED, scheduledDestinations: intent("pinterest", "tiktok"),
  })) === JSON.stringify(["tiktok"]));

check("a scheduled Pinterest-only payload passes",
  blockedScheduleDestinations({ ...SCHEDULED, scheduledDestinations: intent("pinterest") }).length === 0);

// This is the Publish-now shape: no date at all. It must be left completely alone.
check("an UNSCHEDULED payload is never restricted (publish now untouched)",
  blockedScheduleDestinations({
    scheduledDestinations: intent("pinterest", "instagram", "facebook", "tiktok"),
  }).length === 0);

check("a scheduled payload naming no destinations passes",
  blockedScheduleDestinations({ ...SCHEDULED }).length === 0);

// plannedAt is the studio store's authority field and scheduledDate is the
// fallback. Both must trigger the rule, or one entry point silently escapes it.
check("plannedAt (not just scheduledDate) also counts as scheduled",
  blockedScheduleDestinations({
    plannedAt: "2099-01-01T10:00", scheduledDestinations: intent("tiktok"),
  }).length === 1,
  "a payload scheduled via plannedAt must go through the same gate");

// -- the defect: the guard was reading a field nothing writes -----------------
section("server rule: the guard reads the intent that is actually persisted");

check("the providers come from scheduledDestinations",
  JSON.stringify(requestedSocialDestinations({
    scheduledDestinations: intent("pinterest", "instagram"),
  })) === JSON.stringify(["pinterest", "instagram"]));

check("a socialDestinations-only payload is IGNORED — nothing writes that field",
  requestedSocialDestinations({ socialDestinations: ["pinterest", "tiktok"] }).length === 0,
  "reading it would refuse a client for a destination it never scheduled");
check("and it cannot trigger the refusal either",
  blockedScheduleDestinations({ ...SCHEDULED, socialDestinations: ["tiktok"] }).length === 0);
check("a tiktok entry in the REAL field still gets refused",
  JSON.stringify(blockedScheduleDestinations({
    ...SCHEDULED, scheduledDestinations: intent("tiktok"),
  })) === JSON.stringify(["tiktok"]),
  "if this stops failing, the 422 is dead again");

check("two accounts on one platform are ONE destination for this rule",
  JSON.stringify(requestedSocialDestinations({
    scheduledDestinations: [
      { provider: "pinterest", socialConnectionId: "pin_A", capturedAt: AT },
      { provider: "pinterest", socialConnectionId: "pin_B", capturedAt: AT },
    ],
  })) === JSON.stringify(["pinterest"]));

section("server rule: malformed input cannot slip through");
check("a non-array is treated as empty",
  requestedSocialDestinations({ scheduledDestinations: "instagram" }).length === 0);
check("unknown provider strings are discarded",
  JSON.stringify(requestedSocialDestinations({
    scheduledDestinations: [
      { provider: "pinterest", socialConnectionId: "pin_A", capturedAt: AT },
      { provider: "myspace", socialConnectionId: "x", capturedAt: AT },
      42, null,
    ],
  })) === JSON.stringify(["pinterest"]));
check("an entry naming no account is ignored — it can never be dispatched either",
  requestedSocialDestinations({
    scheduledDestinations: [{ provider: "tiktok", capturedAt: AT }],
  }).length === 0,
  "resolveScheduledDestinations drops it too, so there is nothing to refuse");
check("a bogus provider cannot smuggle itself into a schedule",
  blockedScheduleDestinations({
    scheduledDate: "2099-01-01",
    scheduledDestinations: [{ provider: "myspace", socialConnectionId: "x", capturedAt: AT }],
  }).length === 0);

// -- C1: reopening a drawer must not rewrite the merchant's destinations ------
// The defect: PublishDestinations reset the selection to ["pinterest"] on the first
// connections load of EVERY mount, ignoring the parent's current value. The Plan
// drawer mounts it fresh on each open, so reopening a Content scheduled to
// Pinterest + Instagram silently rewrote its intent to Pinterest-only — and
// "Update schedule" then persisted that. These are source contracts: the components
// need React + a browser, but the RULES they must obey are checkable here, and a
// refactor that reinstates either overwrite has to fail something.
section("the destination picker never overwrites a selection it was given");

const picker = readFileSync("src/components/social/PublishDestinations.tsx", "utf8");
const loadBody = picker.slice(
  picker.indexOf("const load = useCallback"),
  picker.indexOf("}, [onSelectedChange]);"),
);

check("the connections load decides nothing about the selection",
  loadBody.length > 200 && !loadBody.includes("onSelectedChange("),
  "load() ran on every mount — that is the reset that erased multi-platform intent");
check("the per-mount selection latch is gone entirely",
  !picker.includes("didInitSelection"),
  "a per-mount latch cannot tell a fresh drawer from a fresh Content");
check("Pinterest is defaulted in exactly ONE place",
  picker.split('onSelectedChange(["pinterest"])').length - 1 === 1);

const defaultBlock = picker.slice(
  picker.indexOf("const didDefaultPinterest = useRef(false);"),
  picker.indexOf('onSelectedChange(["pinterest"]);'),
);
check("the default stands down as soon as the parent has a selection",
  /if \(selected\.length\) \{/.test(defaultBlock),
  "a non-empty selection is the merchant's intent and may never be replaced or added to");
check("the default only ever applies to an EMPTY selection",
  !/onSelectedChange\(\["pinterest", \.\.\.selected/.test(picker),
  "adding Pinterest to an Instagram-only selection corrupts the stored intent on the card path");

// The parent half: the picker can only respect a selection it is GIVEN on its first
// render. Both parents must therefore seed synchronously from the draft's own intent.
section("both parents seed the selection from stored intent before first render");

const drawer = readFileSync("src/components/plan/DraftDetailsDrawer.tsx", "utf8");
check("the drawer seeds the picker's selection in the useState initialiser",
  new RegExp("useState<SocialProvider\\[\\]>\\([\\s\\S]{0,40}seedSocialDestinations").test(drawer));
check("and re-seeds during render when the draft changes",
  /if \(open && draft && selectionSeededId !== draft\.id\) \{[\s\S]{0,200}setSocialDestinations\(seedSocialDestinations\(draft\)\)/.test(drawer),
  "an effect-only seed lands AFTER the freshly mounted picker has already decided");
check("the seed happens above the picker it feeds",
  drawer.indexOf("setSocialDestinations(seedSocialDestinations(draft))") < drawer.indexOf("<PublishDestinations"));
check("the account half of the intent is seeded with it",
  drawer.includes("setSocialAccountIds(seedSocialAccountIds(draft))"),
  "restoring only the platform loses WHICH account was chosen");
check("only EXPLICIT intent seeds a tick",
  /function seedSocialDestinations[\s\S]{0,300}hasExplicitIntent\(draft\)/.test(drawer),
  "a legacy Pin's DERIVED Pinterest destination is our inference, not the merchant's choice");

const card = readFileSync("src/components/studio/PinBoardCard.tsx", "utf8");
check("the card seeds its selection from the Content's own destinations",
  /useState<PublishProvider\[\]>\(\(\) => \{[\s\S]{0,200}contentDestinations\(draft\)/.test(card));
check("the card's Pinterest fallback only applies when there are none",
  /providers\.length \? Array\.from\(new Set\(providers\)\) : \["pinterest"\]/.test(card));

// The rule itself, mirrored (as rowState mirrors DestinationRow below): what the
// picker must decide for each starting state.
function defaultedSelection(selected: string[], pinterestConnected: boolean): string[] {
  if (selected.length) return selected;              // never overwrite intent
  return pinterestConnected ? ["pinterest"] : [];    // fill an empty selection once
}
check("a Pinterest + Instagram selection survives a remount",
  JSON.stringify(defaultedSelection(["pinterest", "instagram"], true))
    === JSON.stringify(["pinterest", "instagram"]));
check("an Instagram-only selection does not gain Pinterest",
  JSON.stringify(defaultedSelection(["instagram"], true)) === JSON.stringify(["instagram"]));
check("a brand-new Content still defaults to Pinterest",
  JSON.stringify(defaultedSelection([], true)) === JSON.stringify(["pinterest"]));
check("with Pinterest not connected, nothing is invented",
  defaultedSelection([], false).length === 0);


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
check("Instagram IS selectable while scheduling now", igSched.actionable);
check("Instagram still reads as connected (not 'Not connected')", igSched.readsAsConnected);
check("Instagram is no longer flagged as schedule-blocked", !igSched.blockedForSchedule);

const fbSched = rowState("facebook", true, true);
check("Facebook IS selectable while scheduling now", fbSched.actionable);
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

// ── which accounts a schedule will actually publish through ─────────────────
// The remove path refuses to delete an account with live schedules. This is the
// other half: the route refuses to WRITE a schedule aimed at an account that is
// gone. Both are needed — with only the first, a tab open since before the
// removal persists a fresh schedule naming the row that just went away.
//
// The 口径 has to match resolveScheduledDestinations, or the route validates a
// different account than the due-time worker will publish through.
section("requiredScheduleConnectionIds names exactly what will be published through");

check("stored destinations name their accounts",
  JSON.stringify(requiredScheduleConnectionIds({
    scheduledDestinations: [
      { provider: "pinterest", socialConnectionId: "c-1" },
      { provider: "facebook", socialConnectionId: "c-2" },
    ],
  })) === JSON.stringify(["c-1", "c-2"]));

check("unusable entries are ignored — the worker would not publish them either",
  JSON.stringify(requiredScheduleConnectionIds({
    scheduledDestinations: [
      { provider: "pinterest", socialConnectionId: "c-1" },
      { provider: "nonsense", socialConnectionId: "c-x" },  // not a provider
      { provider: "facebook", socialConnectionId: "   " },  // no account
    ],
  })) === JSON.stringify(["c-1"]));

check("duplicates collapse (two accounts on one platform are two ids, one id twice is one)",
  JSON.stringify(requiredScheduleConnectionIds({
    scheduledDestinations: [
      { provider: "pinterest", socialConnectionId: "c-1" },
      { provider: "pinterest", socialConnectionId: "c-1" },
    ],
  })) === JSON.stringify(["c-1"]));

// Legacy: only when nothing usable is stored, because that is exactly when
// resolveScheduledDestinations derives a Pinterest-only intent from it.
check("legacy targetConnectionId counts when there are no stored destinations",
  JSON.stringify(requiredScheduleConnectionIds({ targetConnectionId: "old-1" })) === JSON.stringify(["old-1"]));

check("legacy targetConnectionId is IGNORED once real destinations exist",
  JSON.stringify(requiredScheduleConnectionIds({
    targetConnectionId: "old-1",
    scheduledDestinations: [{ provider: "facebook", socialConnectionId: "c-2" }],
  })) === JSON.stringify(["c-2"]),
  "the derivation only happens when the stored list is empty — validating old-1 here would refuse a schedule that never touches it");

check("a payload with no destination intent needs nothing validated",
  requiredScheduleConnectionIds({}).length === 0);

// The route must run the check only for a payload that is actually being
// SCHEDULED — publish-now has no persistence requirement, and an unscheduled
// draft may name anything while the merchant is still editing it.
section("the PUT route wires the destination-exists gate correctly");
{
  const route = readFileSync("src/app/api/pin-drafts/route.ts", "utf8");
  check("route calls requiredScheduleConnectionIds", route.includes("requiredScheduleConnectionIds("));
  check("route calls the server-side availability lookup",
    route.includes("unavailableScheduleDestinations("));
  check("it collects targets only when the draft is being scheduled",
    /if \(incomingScheduledAt\) \{[\s\S]{0,240}requiredScheduleConnectionIds\(p\)/.test(route),
    "an unscheduled draft must not be refused for naming a removed account");
  check("refusal is 422 destination_unavailable",
    route.includes('code: "destination_unavailable"') && /destination_unavailable[\s\S]{0,600}status: 422/.test(route));
  check("the gate runs BEFORE the upsert",
    route.indexOf("unavailableScheduleDestinations(") < route.indexOf(".upsert("),
    "refusing after the write would leave the orphan schedule stored");
}

console.log(`\nSchedule social guard: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
