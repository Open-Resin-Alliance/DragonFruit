---
issue: dragonfruit-kb-harvest-2026-08
date: 2026-08-18
subsystem: voxl-persistence
---

# Autosave and restore lifecycle

## Scenario 1: Autosave beside project

Given an open project with unsaved changes
When the autosave interval triggers
Then an autosave file is written beside the project file
And the main project file is not modified

## Scenario 2: Recover from crash via autosave

Given a project that was open when the application crashed
When I relaunch the application
Then I am prompted to restore from the autosave
And restoring loads the state at the last autosave point
And declining the restore opens the last manually-saved state

## Scenario 3: Handle missing autosave gracefully

Given a project whose autosave file has been deleted
When I open the project
Then the application loads the manually-saved state without errors
And no crash or error dialog appears for the missing autosave

## Scenario 4: Handle corrupted autosave gracefully

Given a project whose autosave file is corrupted (truncated or invalid)
When I relaunch and attempt to restore
Then the application reports the corruption clearly
And falls back to the last manually-saved state
And does not crash or show a raw error trace

## Scenario 5: Window geometry persistence

Given the application window positioned and sized by the user
When I close and reopen the application
Then the window restores to its previous position and size
And on a multi-monitor setup, the window appears on the correct display
