# CRADOS

A tiny browser-native OS experiment: JavaScript is the execution substrate; capabilities are the system interface.

## Run locally

Open `index.html` in a modern browser, or serve the repository root with any static HTTP server. No build step or backend is required.

## GitHub Pages

A GitHub Actions workflow lives at `.github/workflows/pages.yml`. It deploys the repository root when `clear-repo-test` is updated.

- Repository: https://github.com/Gary-0925/temp-ai-coding
- Development branch: `clear-repo-test`
- Workflow: https://github.com/Gary-0925/temp-ai-coding/actions/workflows/pages.yml

If the first deployment does not start, check that GitHub Actions is enabled and that Pages is configured to use **GitHub Actions** in repository Settings → Pages. The repository is currently private; Pages availability depends on the repository owner's GitHub plan and repository settings.

## Prototype features

- Responsive OS shell
- Sandboxed JavaScript guest iframe
- Console bridge
- Permission-gated HTTPS fetch bridge
- Permission-gated IndexedDB virtual files

## Security notes

This is an exploratory prototype, not a hardened security boundary. Sandboxed frames and capability checks reduce accidental access but do not guarantee protection against denial of service or every browser attack. Guest scripts can consume CPU and memory. Network calls remain subject to browser CORS and mixed-content rules. Do not store secrets in the virtual file system.
