# Moving Hatchr's code and downloads to GitLab

GitHub hid the account (Actions and Releases no longer run), so the code and the desktop downloads move to
**https://gitlab.com/hatchr-group1/hatchr** (public, created 2026-11-15, empty). The website stays on
Cloudflare Pages (project `hatchr`, direct upload, domains hatchr.pro and www.hatchr.pro).

Done:
- `.gitlab-ci.yml` builds Windows, Mac (arm64 + x64, ad-hoc signed with rcodesign) and Linux on a `v*` tag and
  publishes a release; tested by building all six 3.9.0 files in a Claude session.
- The GitLab project is public.

Still to do:
1. Done 2026-11-16: the Default Claude environment allows `gitlab.com` and `*.gitlab.com` (needs a new session).
2. Personal access token for the owner's GitLab account (scopes `api`, `write_repository`, ~3 months).
3. Push: `git remote add gitlab https://oauth2:<token>@gitlab.com/hatchr-group1/hatchr.git`,
   `git push gitlab main`, `git push gitlab v3.9.0` (create the tag on the 3.9.0 commit if missing).
4. The first pipeline asks the owner to verify a phone number on GitLab before it runs.
5. Website: point the five download links in `docs/index.html` at
   `https://gitlab.com/hatchr-group1/hatchr/-/releases/permalink/latest/downloads/<file>`
   (Mac gets two: `Hatchr-mac-arm64.zip` for Apple Silicon, `Hatchr-mac-x64.zip` for Intel), remove the
   "Desktop downloads are offline" notice, and deploy `docs/` to Cloudflare Pages.

How the site was deployed last time (Claude in Chrome, owner signed in to Cloudflare): Workers & Pages → `hatchr` →
Create deployment → Production → the `.zip` file input. The file-upload tool takes at most 3.8 MB per call and the
site is ~8.5 MB (the promo mp4 is 6 MB), so the zip was built inside the dashboard tab: the unchanged files were
fetched from https://hatchr.pro (Pages sends `Access-Control-Allow-Origin: *`) and checked against `docs/` by
SHA-256, the new `index.html` was uploaded through a temporary file input, a stored zip was written in the page and
set on the zip input, then "Save and deploy". Upload only `docs/` contents, without `CNAME` and `.nojekyll`.
