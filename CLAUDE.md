# carcassonne

T.OF... のアプリ。https://t-of.github.io/carcassonne/

- ルールは本部の `~/GitHub/tof/t-of.github.io/RULES.md` に従う（全アプリ共通）。ブランドは `docs/BRAND.md`。
- 直したら本部で `npm run audit:browser -- carcassonne` を通す。
- 公開は本部の `docs/RELEASE.md` の手順。大きな作業は本部で Claude を起動すると、役割を分けて進められる。
- localStorage のキーは `carcassonne.` で始める。SW のキャッシュ名は `carcassonne-` で始める。
- 見た目はドット絵だけ。廃止した「シンプル」の見た目は `~/GitHub/tof/drafts/carcassonne-simple-theme/` に控えてある。このアプリを直しても、控えは更新しない。
