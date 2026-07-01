# multi-select-tagging

## Purpose

Defines how adding and removing a tag behaves when the action applies across a multi-asset selection in the toolbar tag editor (`FileTagEditor`), specifically the none/partial/all decision for whether an entered tag fills in the missing assignments or is removed.

## Requirements

### Requirement: Entering a tag across a multi-asset selection fills before it removes

When the user enters (clicks or confirms) a tag in the toolbar tag editor while two or more assets are selected, the system SHALL decide between adding and removing based on how many of the selected assets already carry that tag, using a none/partial/all tri-state. Filling in missing assignments SHALL take precedence: the tag is only removed when every selected asset already has it.

Because `ClientFile.addTag`/`removeTag` are idempotent, the add operation MAY be applied to the entire selection; assets that already have the tag are left unchanged.

#### Scenario: No selected asset has the tag

- **WHEN** the user enters a tag and none of the selected assets currently have it
- **THEN** the tag is added to all selected assets

#### Scenario: Some but not all selected assets have the tag

- **WHEN** the user enters a tag and at least one — but not all — of the selected assets currently have it
- **THEN** the tag is added to the selected assets that do not yet have it
- **AND** the assets that already have the tag keep it (no asset loses the tag)

#### Scenario: Every selected asset already has the tag

- **WHEN** the user enters a tag and all of the selected assets currently have it
- **THEN** the tag is removed from all selected assets

#### Scenario: Single asset selected

- **WHEN** exactly one asset is selected and the user enters a tag
- **THEN** the tag is added if that asset lacks it and removed if it already has it (the all-case and none-case collapse to the same single-asset toggle)

### Requirement: Explicit tag removal is unaffected

The explicit per-tag remove control ("×") in the selection's tag summary SHALL continue to remove that tag from every selected asset regardless of the tri-state, so the user retains a direct way to clear a tag from the whole selection.

#### Scenario: User clicks the remove control on a summary tag

- **WHEN** the user clicks the "×" remove control next to a tag in the multi-selection summary
- **THEN** the tag is removed from all selected assets that have it
