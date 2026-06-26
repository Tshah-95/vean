# Licensing rationale

> Not legal advice. Before actually selling commercial exceptions (dual
> licensing), get a short consult with an OSS-licensing lawyer — it's cheap
> insurance for a sticky decision.

vean is **AGPL-3.0**, with contributions accepted under a **CLA**. This file
records *why*, because the reasoning is non-obvious and the decision is expensive
to reverse.

## The thing most license advice gets wrong for a video editor

Generic advice says "a usable video editor links FFmpeg, and the good codecs
(`libx264`/`libx265`) and many filters are GPL, so your binary is forced to GPL
no matter what's in your LICENSE file." That's true for **Kdenlive, Shotcut,
OpenShot, Olive** — they are C++ apps that **link** `libavcodec`/`libmlt` into
their own address space, so the combined work is a GPL derivative. It's why every
major open-source editor is GPL.

**It does not apply to vean.** vean never links any GPL code. It drives `melt`
(GPLv2) as a **separate process**, communicating through the public `.mlt` file
format and command-line arguments. The FSF is explicit that this is arm's-length:

> *"Pipes, sockets and command-line arguments are communication mechanisms
> normally used between two separate programs. So when they are used for
> communication, the modules normally are separate programs… if the program uses
> fork and exec to invoke [a separate program], then [it is a] separate program,
> so the license for the main program makes no requirements for them."*
> — [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html)

(The one caveat in that FAQ — "intimate semantics exchanging complex internal
data structures" — is about *internal* data structures. A documented, public XML
interchange format is the textbook *separate-programs* case.)

MLT itself confirms the split: the framework (`libmlt`) is **LGPLv2.1**, while
`melt`/`melted` are **GPLv2** — see the
[MLT copyright policy](https://www.mltframework.org/docs/copyrightpolicy/). We
depend on `melt` the *binary*, not the library, and not by linking.

**Consequence:** vean's distributed artifact is **pure TypeScript with zero GPL
code in it.** Our license is therefore a free *choice*, not a codec-forced
necessity.

## Why AGPL-3.0 anyway (a deliberate, reversible choice)

We choose copyleft on purpose:

- **Protects a future hosted/collaborative version.** The day vean gains a
  cloud-render or browser-based collaboration surface, the AGPL network clause
  stops a competitor from running a modified copy as a private service without
  contributing back. For a pure local CLI/library it costs little; as insurance
  for the product direction, it's free.
- **Prevents proprietary closed forks** of the core (the underlying GPL
  copyleft).
- **Enables dual licensing.** Paired with the CLA, AGPL is the proven
  monetization path (the MySQL/MongoDB/Qt playbook): the project is free under
  AGPL, and anyone who wants to embed vean without copyleft obligations buys a
  commercial exception.

## Why it's reversible (the optionality that made this safe)

Because (a) we hold copyright on all contributions via the CLA, and (b) we are
**not** codec-locked (no GPL linking), we can **relicense later** — e.g. loosen
to Apache-2.0 if adoption ever matters more than protection. Most projects can't
do this: outside contributions under a fixed license freeze the choice forever.
The CLA + the no-linking architecture are exactly what keep this door open. AGPL
is the strict starting point with the most doors still open behind it.

## The CLA is the load-bearing decision

The license can be changed later *only* if we control the copyright. That means a
CLA from **day one** — accept even one un-CLA'd external PR and the dual-license
(and relicense) door quietly closes. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Downstream note (not a vean-license issue)

If a *product* built on vean embeds **Remotion** in a hosted/automated form
above Remotion's free tier (individuals / orgs ≤3 people), that triggers a
Remotion **company license** — see [remotion.dev/docs/license](https://www.remotion.dev/docs/license).
That's a concern for whoever ships such a product, independent of vean's own
license. vean treats Remotion as an optional, user-provided peer dependency.
