# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker (GitHub Issues).

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Wayfinder labels

The `/wayfinder` skill uses these labels for map and ticket issues. They are applied alongside the triage roles above. The label vocabulary is single-sourced from the deck's canonical set (`shared/labels.js`).

| Label                | Meaning                                             |
| -------------------- | --------------------------------------------------- |
| `wayfinder:map`      | The map issue: Notes / Decisions-so-far / Fog body |
| `wayfinder:research` | A wayfinder research ticket                         |
| `wayfinder:prototype` | A wayfinder prototype ticket                       |
| `wayfinder:grilling` | A wayfinder grilling ticket                        |
| `wayfinder:task`     | A wayfinder task ticket                            |

When a skill mentions a wayfinder type, use the corresponding label string from this table. The full canonical set of 10 core labels (used by the setup environment check) is:

`bug`, `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task`.
