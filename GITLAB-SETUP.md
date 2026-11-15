# Moving Hatchr's code and downloads to GitLab

GitHub hid the account (Actions and Releases no longer run), so the code and the desktop downloads move to
**https://gitlab.com/hatchr-group1/hatchr** (public, created 2026-11-15, empty). The website stays on
Cloudflare Pages (project `hatchr`, direct upload, domains hatchr.pro and www.hatchr.pro).

Done:
- `.gitlab-ci.yml` builds Windows, Mac (arm64 + x64, ad-hoc signed with rcodesign) and Linux on a `v*` tag and
  publishes a release; tested by building all six 3.9.0 files in a Claude session.
- The GitLab project is public.

Still to do:
1. The Claude environment needs `gitlab.com` and `registry.gitlab.com` in its network access (Custom).
2. Personal access token for the owner's GitLab account (scopes `api`, `write_repository`, ~3 months).
3. Push: `git remote add gitlab https://oauth2:<token>@gitlab.com/hatchr-group1/hatchr.git`,
   `git push gitlab main`, `git push gitlab v3.9.0` (create the tag on the 3.9.0 commit if missing).
4. The first pipeline asks the owner to verify a phone number on GitLab before it runs.
5. Website: point the five download links in `docs/index.html` at
   `https://gitlab.com/hatchr-group1/hatchr/-/releases/permalink/latest/downloads/<file>`
   (Mac gets two: `Hatchr-mac-arm64.zip` for Apple Silicon, `Hatchr-mac-x64.zip` for Intel), remove the
   "Desktop downloads are offline" notice, and deploy `docs/` to Cloudflare Pages.
