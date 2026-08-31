# Deferred

Everything here is known, reproduced, and deliberately not fixed.

The project stopped on a rule worth writing down: after the final report, a
defect that cannot silently cost a real opportunity is recorded and left. The
goal was never a perfect tool. It was a tool that does not let a window pass
unseen — and past that line, more work costs more than it returns.

Each entry says what it is, what it would cost, and — the part that decides
whether it stays here — what it would actually cost him if it is never fixed.

---

## Coverage

**One record per page.** A careers page listing four programmes yields one, and
hides three. Mitigated rather than fixed: the classifier reports `moreOnPage`
and the card says the page holds more, so he opens it himself. Fixing it
properly means letting one source produce several records, which changes how a
record is identified. *If never fixed: he sees one of several programmes on a
page, and is told so.*

**Ten organisations have no readable source.** `taqnia` and `derayah` paint
their pages with script and yield nothing even to a real browser; `devoteam_sa`
answers 403; `kasb` serves a broken certificate; `media.gov.sa` forbids every
crawler but the search engines in `robots.txt`, which is obeyed. Each carries
its reason in the app. *If never fixed: those ten need checking by hand, and
the app says which.*

**A window shorter than six hours is invisible.** Published and closed between
two rounds. The only remedy is a faster cadence. *If never fixed: an
announcement open for less than a working day could pass unseen — rare, and
unbounded only in theory.*

**Three decision fields are almost entirely unknown.** `requiresZeroCourses` is
known for one organisation in 115, `acceptsUserMajor` for three, `city` for
five. The filters work; there is little to filter. This is slow manual reading
with no shortcut. *If never fixed: the filters return short lists, and the
chips honestly say "unknown" rather than guessing.*

## The pipeline

**Seats, duration and cities still come from the model.** Dates were moved to a
calendar table because a wrong date costs a semester. These three are extracted
by the model and it has been seen to drop all three from a sentence it otherwise
read correctly. *If never fixed: a card occasionally omits a seat count the page
published.*

**`verify-leads` grades its own work.** It stamps `provenance: "official"` on
any page on the organisation's own domain that yields readable text. The narrower
claim — that the page is about cooperative training — is separated into
`coopConfirmed` and shown as such, but the stamp itself is automatic. *If never
fixed: "official" means less than a reader might assume, and the interface says
what it actually means.*

**Two collectors write to one branch.** The laptop and the runner each commit
`data/`. The push now rebases and retries three times, and fails loudly rather
than green. *If never fixed: a rare lost round, announced.*

## Interface

**Predicted windows are not drawn.** The Season Bar has the legend slot and the
specification asks for hatched "متوقع" lanes. It needs previous cycles, and the
dataset has none of its own yet. *If never fixed: the bar shows what is known
and nothing more, which is the honest state.*

**`rawExcerpt` is stored and never shown.** Spec 3.2 keeps 400 characters "for
the user to read himself"; nothing renders it. *If never fixed: he opens the
page instead.*

**`verification.json` is deployed and never read.** 529 KB of audit trail in the
published bundle that the browser never fetches. *If never fixed: a slower first
load on mobile data.*

## Operations

**Collection depends on one laptop.** GitHub's runners are refused by many
`.gov.sa` hosts, so the machine in Riyadh is the only one that can read them. It
now runs on battery, catches up a missed round, and writes a heartbeat the app
alarms on — but it is still one machine. *If never fixed: collection stops while
that machine is off, and the home screen says so in red after twelve hours.*

**Email is built and not configured.** `RESEND_API_KEY` and `NOTIFY_EMAIL` are
unset, so the digest channel is off. Nothing is lost by it: an undelivered
notice is queued and pushed by the next round that may send. *If never fixed:
one channel instead of two.*

**Untested hostile inputs.** A server that drips a response a byte at a time,
and a redirect to an internal address. The size cap and the timeout bound both,
but neither has been driven on purpose. *If never fixed: a slow source could
hold one of two concurrent fetch slots until its timeout.*
