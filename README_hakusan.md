# カルカソンヌの CPU を HAKUSAN で学習する

計算は HAKUSAN（Slurm）で回す。手元の Mac では回さない。ジョブは 64 コア（`-p DEF -n 64`）。
`<…>` のところは自分の値に置き換える。

## 0. 手元で固める

```sh
cd ~/GitHub/tof/apps/carcassonne
npm test
npm run pack:hakusan      # hakusan-carcassonne.tar.gz ができる
```

## 1. Node を入れる（初回だけ。root 不要）

hakusan1 に入って（VS Code の Remote-SSH）:

```sh
cd ~
curl -LO https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz   # 外に出られなければ Mac で落として scp
tar xf node-v22.11.0-linux-x64.tar.xz
echo 'export PATH=$HOME/node-v22.11.0-linux-x64/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
node -v
```

## 2. 送って展開する

Mac のターミナルで（ユーザー名・ホスト名は普段の接続に合わせる）:

```sh
scp ~/GitHub/tof/apps/carcassonne/hakusan-carcassonne.tar.gz hakusan1:~/
```

hakusan1 で:

```sh
mkdir -p ~/carcassonne && cd ~/carcassonne
tar xzf ~/hakusan-carcassonne.tar.gz
```

コードを直して送り直しても、`runs/` と `logs/` は消えない（tar に入っていない）。

## 3. probe（5 分。1 世代の時間と局数を測る）

```sh
cd ~/carcassonne
sbatch jobs/job_probe.sh
squeue -u $USER
tail -f logs/carc-probe-*.out      # 止めるのは Ctrl+C
```

既定は 1 世代 = 自己対局 512 局 + 候補 vs 最良 400 局 + 最良 vs 手書き探索 200 局。
局数や読む回数を変えて測るときは引数を足す。例:

```sh
sbatch jobs/job_probe.sh --games 256 --arena-games 200 --ref-games 100 --self-iters 6 --arena-iters 12
```

## 4. 本番

```sh
cd ~/carcassonne
sbatch -t 12:00:00 jobs/job_train.sh run1 720    # 名前 run1、720 分（= 枠 12 時間）。枠の時間と分は合わせる
```

- 枠の上限は `sinfo` で DEF の TIMELIMIT を見て、それ以下にする。
- 学習側は「分 − 15」で止まる（世代の途中で切られないため）。
- 終わったら（または時間切れの後）同じコマンドを打てば、`runs/run1/` の続きから進む。
- 局数や iters を変えたいときも、同じ名前の末尾に引数を足せば続きから変わる: `sbatch -t 12:00:00 jobs/job_train.sh run1 720 --games 1024`。

### probe の後に局数をどう決めるか

probe のログ最後の「N 秒」が 1 世代の時間。64 コアでの目安は 1 世代 5〜15 分。

- 1 世代が 15 分を超える → `--games`・`--arena-games`・`--ref-games` を同じ割合で減らす（採用の判定は 400 局を割らないほうがよいので、先に `--games` と `--ref-games` を減らす）。
- 5 分に満たない → `--games` を増やす（局面が増えて網が育つ）。
- `--self-iters`（自己対局の読む回数）と `--arena-iters`（判定の読む回数）は、増やすほど 1 局が重くなる。局数より先に触らない。

## 5. 様子の見方

```sh
squeue -u $USER
tail -n 30 logs/carc-train-*.out
```

見るところ:

- `世代 N: 自己対局 … 局面 +…` : 局面が増えているか。
- `検証損失 開始 … → エポック …` : 世代を重ねて下がるか。「動かない」基準より下に行っていれば学べている。
- `候補の勝率 …% → 採用/見送り` : 55% 以上で採用。見送りが続くのは、まだ伸びていないか読む回数が少ない。
- `最良の網 vs 手書きの探索 … 勝率` : **これが外の物差し**。世代を重ねて 50% を超えて上がっていけば強くなっている。
- 履歴は `runs/<名前>/state.json` の `history`（`vsSearch` がこの勝率）。

## 6. 持ち帰る

最良の網は `runs/<名前>/best.json`。Mac で:

```sh
scp hakusan1:~/carcassonne/runs/run1/best.json ~/GitHub/tof/apps/carcassonne/ai/model.json
cd ~/GitHub/tof/apps/carcassonne && npm test
```

そのあと CPU の確認と公開は本部の手順で。
