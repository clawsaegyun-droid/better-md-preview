# Better MD Preview

GitHub-style Markdown preview for VS Code with a clickable heading legend on the left.

## Features

- GitHub Markdown CSS based preview.
- GFM-friendly rendering for tables, strikethrough, fenced code, task lists, and footnotes.
- Left heading legend grouped by Markdown title level.
- Click a heading in the legend to jump to that section.
- Updates as the Markdown document changes.

## Usage

Open a Markdown file and run `Better MD Preview: Open Preview to the Side`.

The extension also binds the standard Markdown preview shortcut:

- Windows/Linux: `Ctrl+K V`
- macOS: `Cmd+K V`

## Releases

Releases are built by GitHub Actions. Push a semantic version tag such as
`v0.1.4`, or run the `Release` workflow manually with a tag input. The workflow
runs lint, packages the VSIX, creates `SHA256SUMS`, and publishes both files to
the GitHub Release.
