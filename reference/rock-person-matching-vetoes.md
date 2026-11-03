> Portability: observed behavior, not a version guarantee. Discover all IDs locally; examples are not production configuration.

# Rock person matching — the two FindPersons vetoes + AccountProtectionProfile (7/2026)

Why a public form "creates a duplicate instead of matching an existing person." Governs ANY
flow that uses `GetPersonFromFields` / `PersonService.FindPersons` — native WorkflowEntry
person entry, connection cards, custom wizards — and matters for staff offboarding.
Confirmed against Rock 17.7 source + live behavior on this instance (2026-07-08).

## The two independent vetoes

`PersonService.FindPersons` (Rock/Model/CRM/Person/PersonService.cs) can refuse a match for
EITHER reason — both must pass:

1. **AccountProtectionProfile veto.** The instance security setting
   `AccountProtectionProfilesForDuplicateDetectionToIgnore` = **[Extreme] only**. Anyone whose
   `Person.AccountProtectionProfile` = Extreme (3) is filtered out of the candidate query AND
   hard-vetoed in `MeetsMinimumConfidence`, regardless of match score. Low(0)/Medium(1)/High(2)
   all match fine — only Extreme is blocked. Practical effect: **staff and other elevated
   people always duplicate on public match forms.**

2. **Birthdate-mismatch veto.** In FindPersons, if the submission includes a DOB, the candidate
   query keeps only people whose `BirthMonth`+`BirthDay` match exactly (or are null on file).
   A DOB typo → duplicate, even for a Low-profile person. Year never gates the candidate set
   (it only adds +5 to the score). So any form that collects DOB is subject to this; to match
   an existing person you must submit their exact birth month+day (or they must have no DOB
   on file).

Scoring for reference (cutoff 35): First+15 (FirstName OR NickName, case-insensitive) /
Last+15 / (email | mobile | previous-email)+15 / DOB month+day+10 / +year+5 / Gender+3 /
Suffix+10. FindPersons never reads PersonAlias — merge history is irrelevant (it only ADDS
matchable data via PersonSearchKey/PreviousName).

## AccountProtectionProfile is calculated, cached — and counts INACTIVE members

Source: generalized technical observations; verify against this church and Rock version.
**archived** group members and inactive **groups**, but does **NOT check `GroupMemberStatus`** —
so an **Inactive (not archived) member of an Extreme security-role group still gets
AccountProtectionProfile = Extreme.**

- Other drivers: active financial (saved account / active scheduled transaction) → High/Extreme;
  a UserLogin → Medium (which still matches).
- The value is a **stored field on Person**, recalculated by the nightly **Rock Cleanup** job
  and by a GroupMember save-hook when membership changes. It is NOT live. **A manual override
  of the field gets overwritten** back to the calculated value on the next recalc if the
  underlying drivers remain (observed live: a test person set to Low was back at Extreme
  within minutes off still-present inactive memberships).

## How to actually de-elevate someone (e.g. offboarding staff)

- **Inactivating their security-role membership is NOT enough** — inactive still counts.
  **Archive or remove** the membership.
- **Synced security roles re-add them.** RSR - Staff Workers (Group **3**) is DataView-synced:
  hand-archiving is undone on the next group sync unless the person also drops out of the
  sync's DataView. Non-synced roles (e.g. RSR - Rock Administration, Group **2**) stay removed.
  Other Extreme roles on this instance: WEB - General Editor (**5**), RSR - Benevolence (**<discover ID>**).
  `ElevatedSecurityLevel` enum: 0=None, 1=High, 2=Extreme.
- After archiving/removing, the profile refreshes on the next recalc (nightly job, or force it
  by re-saving the person / running Rock Cleanup). Manually setting the field only sticks once
  the drivers are actually gone.

## Policy note

The Extreme-profile veto is a deliberate Rock security control (it stops a stranger from
"matching onto" a staff account from a public form). The standing decision on this instance is
to **accept the resulting staff/Extreme duplicates on public forms rather than bypass the
control** — this note documents the mechanism and the offboarding procedure, not a bypass.
