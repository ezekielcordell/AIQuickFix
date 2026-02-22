# AI Quick Fix (GitHub Maintainer Notes)

This file is for repository maintainers and is not shipped in the VSIX package.

## Publish To VS Code Marketplace

### Prerequisites

- You are a member of the `ezekielcordell` publisher in VS Code Marketplace.
- You have an Azure DevOps Personal Access Token (PAT) with `Marketplace (Manage)` scope.

### One-time login

```bash
npm run publish:login -- ezekielcordell
```

### Standard release flow

1. Ensure you are on `main` and up to date.
2. Update `CHANGELOG.md` for the release.
3. Bump version (example patch release):

```bash
npm version patch --no-git-tag-version
```

4. Build:

```bash
npm run build
```

5. Commit and push release changes:

```bash
git add .
git commit -m "Release x.y.z"
git push origin main
```

6. Publish exactly the current version in `package.json` (no manual `.vsix` step):

```bash
npm run publish
```

### Alternative publish commands

- Auto patch bump:

```bash
npm run publish:patch
```

- Auto minor bump:

```bash
npm run publish:minor
```

- Auto major bump:

```bash
npm run publish:major
```

### Common errors

- `TF400813 ... not authorized`
: PAT is invalid/expired or missing required scope. Run login again.
- `The supplied tag '*' is not a valid tag`
: Ensure no wildcard tags leak into package metadata (for this project, avoid `onLanguage:*` activation event).
