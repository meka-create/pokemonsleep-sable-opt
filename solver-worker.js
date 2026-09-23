
    'use strict';

    self.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type !== 'solve') return;

      const startedAt = performance.now();
      try {
        const context = makeContext({
          premium: !!msg.premium,
          guaranteedCount: msg.guaranteedCount,
          detailEnabled: !!msg.detailEnabled,
          futureGuarantees: msg.futureGuarantees,
          maxEncounters: msg.state?.encounters,
          inventory: msg.state?.inventory || {}
        });
        const result = solve(context, msg.state || {});
        result.calcMs = performance.now() - startedAt;
        self.postMessage({ type: 'result', requestId: msg.requestId, result });
      } catch (error) {
        self.postMessage({
          type: 'error',
          requestId: msg.requestId,
          message: error && error.stack ? error.stack : String(error)
        });
      }
    };

    function makeContext(cfg) {
      const premium = !!cfg.premium;
      // UIの確定ラインは現在遭遇だけの条件。詳細設定OFFでは次回以降を通常の3枚保証、
      // ONでは順番付きの将来スケジュール（2枚/3枚）をそのまま期待値計算へ反映する。
      const currentGuar = Number(cfg.guaranteedCount) === 2 ? 2 : 3;
      const standardGuar = 3;
      const maxEnc = Math.max(0, Math.floor(Number(cfg.maxEncounters) || 0));
      const detailEnabled = !!cfg.detailEnabled;
      const rawFutureGuarantees = Array.isArray(cfg.futureGuarantees) ? cfg.futureGuarantees : [];
      // 詳細設定OFFでは従来どおり将来遭遇をすべて3枚保証として扱う。
      // ONの場合だけ、現在遭遇を除く順番付きスケジュールをDPへ反映する。
      const futureGuarantees = Array.from({ length: Math.max(0, maxEnc - 1) }, (_, i) =>
        detailEnabled && Number(rawFutureGuarantees[i]) === 2 ? 2 : 3
      );
      const hasTwoGuarantee = currentGuar === 2 || futureGuarantees.some((v) => v === 2);
      const values = { s6: 6, s5: 5, s4: premium ? 4 : 3, s3: 3, s1: 1 };
      const ids = ['s6', 's5', 's4', 's3', 's1'];
      const maxCounts = {};
      const isInf = {};

      for (const id of ids) {
        // 2枚保証（分割睡眠2回目）はゲーム条件としてボーナスサブレ無し。
        // UI入力や保存状態に値が残っていても、Worker側で必ず0として扱う。
        const raw = id === 's4' && currentGuar === 2 ? 0 : cfg.inventory?.[id];
        isInf[id] = raw === '∞';
        if (isInf[id]) {
          maxCounts[id] = 0;
          continue;
        }

        const n = Math.max(0, Math.floor(Number(raw) || 0));
        if (id === 's4') {
          // ボーナスサブレはUI上も1枚が上限で、次の出会いで1枚に戻る。
          maxCounts[id] = Math.min(n, 1);
        } else {
          // 厳密な上限。1回の捕獲までに、この種類だけを通常成功で投げ続けても
          // ceil(30 / value)枚で必ずゲージ30に到達する。
          // 捕獲できる回数は残り出会い回数を超えないため、これを超える在庫は
          // イベント中に物理的に消費できず、最適行動にも影響しない。
          const horizonCap = maxEnc * Math.ceil(30 / values[id]);
          maxCounts[id] = Math.min(n, horizonCap);
        }
      }

      const radix = {
        phase: standardGuar + 1,
        mode: hasTwoGuarantee ? 2 : 1, // 現在または将来に2枚保証がある時だけ状態軸を持つ
        s6: isInf.s6 ? 1 : maxCounts.s6 + 1,
        s5: isInf.s5 ? 1 : maxCounts.s5 + 1,
        s4: 2,
        s3: isInf.s3 ? 1 : maxCounts.s3 + 1,
        s1: isInf.s1 ? 1 : maxCounts.s1 + 1,
        enc: maxEnc + 1
      };

      // 通常の14回ケースではNumberの整数キーで安全に一意化できる。
      // 極端に大きいユーザー入力だけ文字列キーへ自動フォールバックする。
      let keySpace = 31 * radix.phase * radix.mode * 2;
      keySpace *= radix.s6 * radix.s5 * radix.s4 * radix.s3 * radix.s1 * radix.enc;
      const useNumericKey = Number.isSafeInteger(keySpace) && keySpace <= Number.MAX_SAFE_INTEGER;
      const makeMemo = () => {
        const DENSE_LIMIT = 10000000;
        if (useNumericKey && keySpace <= DENSE_LIMIT) {
          const ev = new Float64Array(keySpace);
          const action = new Int8Array(keySpace);
          action.fill(-128);
          let memoSize = 0;
          return {
            getEV(k) { return action[k] === -128 ? undefined : ev[k]; },
            getAction(k) { return action[k]; },
            set(k, value, bestAction) {
              if (action[k] === -128) memoSize++;
              ev[k] = value; action[k] = bestAction;
            },
            get size() { return memoSize; }
          };
        }
        const map = new Map();
        return {
          getEV(k) { const v = map.get(k); return v === undefined ? undefined : v[0]; },
          getAction(k) { const v = map.get(k); return v === undefined ? -128 : v[1]; },
          set(k, value, bestAction) { map.set(k, [value, bestAction]); },
          get size() { return map.size; }
        };
      };

      return {
        premium,
        currentGuar,
        standardGuar,
        maxEnc,
        detailEnabled,
        futureGuarantees,
        values,
        isInf,
        maxCounts,
        radix,
        useNumericKey,
        memo: makeMemo()
      };
    }

    function solve(ctx, input) {
      const EPS = 1e-12;
      const TARGET = 30;

      const clampCount = (id, raw) => {
        if (ctx.isInf[id]) return -1; // -1 = 無限
        const n = Math.max(0, Math.floor(Number(raw) || 0));
        return Math.min(n, ctx.maxCounts[id]);
      };

      const inv = input.inventory || {};
      const startInv = {
        s6: clampCount('s6', inv.s6),
        s5: clampCount('s5', inv.s5),
        // 2枚保証ではボーナスサブレは存在しない。不正な入力経路があっても0固定。
        s4: ctx.currentGuar === 2 ? 0 : Math.max(0, Math.min(1, Math.floor(Number(inv.s4) || 0))),
        s3: clampCount('s3', inv.s3),
        s1: clampCount('s1', inv.s1)
      };

      const g = Math.max(0, Math.min(TARGET, Math.floor(Number(input.gauge) || 0)));
      // cf >= guar では以後の満腹確率が常に同じなので、guar+1個の状態に厳密圧縮できる。
      const startMode = ctx.currentGuar === 2 ? 1 : 0;
      const guarForMode = (mode) => mode === 1 ? 2 : ctx.standardGuar;
      const isStandardThreeGuaranteeMode = (mode) => mode === 0;
      // ce は「現在遭遇を含む残り出会い回数」。maxEncとの差から、
      // 次回以降のどのスケジュール位置かを一意に求められる。
      const modeForRemaining = (ce) => {
        if (ce >= ctx.maxEnc) return startMode;
        const index = ctx.maxEnc - ce - 1;
        return Number(ctx.futureGuarantees[index]) === 2 ? 1 : 0;
      };
      const bonusForMode = (mode) => mode === 1 ? 0 : 1;
      const phase = Math.max(0, Math.min(guarForMode(startMode), Math.floor(Number(input.fedCount) || 0)));
      const enc = Math.max(0, Math.min(ctx.maxEnc, Math.floor(Number(input.encounters) || 0)));
      const chance = !!input.chance && phase === 0;

      const actions = [
        { id: 's1', val: 1, name: 'ポケ(1)' },
        { id: 's3', val: 3, name: 'スーパー(3)' },
        { id: 's4', val: ctx.values.s4, name: ctx.premium ? 'ボーナス+(4)' : 'ボーナス(3)' },
        { id: 's5', val: 5, name: 'ハイパー(5)' },
        { id: 's6', val: 6, name: 'ミュウツー(6)' }
      ];

      // 同期待値時の比較は探索順に依存させず、後段の完全な比較器で一意に決める。
      // 小さい数字を基本とし、同値（プレパスOFFの3 vs 3）では使い切り資源のボーナスを先にする。
      const smallActionRank = (a) => a.val * 10 + (a.id === 's4' ? 0 : 1);
      const stableActionRank = (a) => ({ s4: 0, s1: 1, s3: 2, s5: 3, s6: 4 }[a.id] ?? 99);
      const isExpiringBonus = (id) => id === 's4';
      // ボーナスは次の遭遇へ持ち越せない「使い切り資源」なので、有限在庫の節約対象には含めない。
      const isCarryoverFinite = (id) => id !== 's4' && !ctx.isInf[id];
      const encoded = (id, value) => ctx.isInf[id] ? 0 : value;

      const getCount = (id, s6, s5, s4, s3, s1) => {
        if (id === 's6') return s6;
        if (id === 's5') return s5;
        if (id === 's4') return s4;
        if (id === 's3') return s3;
        return s1;
      };

      const decrementForAction = (id, s6, s5, s4, s3, s1) => {
        let ns6 = s6, ns5 = s5, ns4 = s4, ns3 = s3, ns1 = s1;
        const count = getCount(id, s6, s5, s4, s3, s1);
        if (count !== -1) {
          if (id === 's6') ns6--;
          else if (id === 's5') ns5--;
          else if (id === 's4') ns4--;
          else if (id === 's3') ns3--;
          else ns1--;
        }
        return [ns6, ns5, ns4, ns3, ns1];
      };

      // 19以上の温存目安など、通常3枚保証向けの一般則は標準モードで適用。
      // 分割2回目（mode=1）は「2枚で届くなら確定させる」を優先し、
      // 届かない場合は次の通常3枚保証遭遇まで含めてDPで比較する。

      // ベースデータ準拠の「確定取り切り」判定。
      // 残っている確定給餌回数の中で、最悪ケース（通常成功）でもゲージ30へ
      // 到達できるなら、その日のうちに取り切れる状態とみなす。
      // チャンス1投目は超成功でなくても必ず3倍なので、最低獲得量を3倍として扱う。
      const maxGuaranteedGain = (mode, cp, cChance, s6, s5, s4, s3, s1) => {
        const guar = guarForMode(mode);
        const throwsLeft = Math.max(0, guar - cp);
        if (throwsLeft <= 0) return 0;

        const topNormalGain = (limit, cs6, cs5, cs4, cs3, cs1) => {
          let total = 0;
          let c6 = cs6, c5 = cs5, c4 = cs4, c3 = cs3, c1 = cs1;
          for (let t = 0; t < limit; t++) {
            let bestId = null;
            let bestVal = -1;
            if (c6 !== 0 && 6 > bestVal) { bestId = 's6'; bestVal = 6; }
            if (c5 !== 0 && 5 > bestVal) { bestId = 's5'; bestVal = 5; }
            if (c4 !== 0 && ctx.values.s4 > bestVal) { bestId = 's4'; bestVal = ctx.values.s4; }
            if (c3 !== 0 && 3 > bestVal) { bestId = 's3'; bestVal = 3; }
            if (c1 !== 0 && 1 > bestVal) { bestId = 's1'; bestVal = 1; }
            if (bestId === null) break;

            total += bestVal;
            if (bestId === 's6' && c6 !== -1) c6--;
            else if (bestId === 's5' && c5 !== -1) c5--;
            else if (bestId === 's4' && c4 !== -1) c4--;
            else if (bestId === 's3' && c3 !== -1) c3--;
            else if (bestId === 's1' && c1 !== -1) c1--;
          }
          return total;
        };

        if (!(cChance && cp === 0)) {
          return topNormalGain(throwsLeft, s6, s5, s4, s3, s1);
        }

        let best = 0;
        for (let ai = 0; ai < actions.length; ai++) {
          const a = actions[ai];
          const count = getCount(a.id, s6, s5, s4, s3, s1);
          if (count === 0) continue;
          const [ns6, ns5, ns4, ns3, ns1] = decrementForAction(a.id, s6, s5, s4, s3, s1);
          const gain = a.val * 3 + topNormalGain(throwsLeft - 1, ns6, ns5, ns4, ns3, ns1);
          if (gain > best) best = gain;
        }
        return best;
      };

      const canGuaranteeCatch = (mode, cg, cp, cChance, s6, s5, s4, s3, s1) => {
        if (cg >= TARGET) return true;
        if (cp >= guarForMode(mode)) return false;
        return cg + maxGuaranteedGain(mode, cp, cChance, s6, s5, s4, s3, s1) >= TARGET;
      };

      const countAvailable = (v) => v === -1 || v > 0;

      // 「今この1投を投げても、最悪ケースで保証内100%捕獲を維持できるか」。
      // 保証内捕獲はハード制約ではなく、イベント全体期待値が同じ候補の比較にだけ使う。
      const actionPreservesGuaranteedFinish = (mode, ai, cg, cp, cChance, s6, s5, s4, s3, s1) => {
        const a = actions[ai];
        const count = getCount(a.id, s6, s5, s4, s3, s1);
        if (count === 0) return false;
        const [ns6, ns5, ns4, ns3, ns1] = decrementForAction(a.id, s6, s5, s4, s3, s1);
        const minMultiplier = (cChance && cp === 0) ? 3 : 1;
        const ng = Math.min(TARGET, cg + a.val * minMultiplier);
        if (ng >= TARGET) return true;
        const np = Math.min(guarForMode(mode), cp + 1);
        return canGuaranteeCatch(mode, ng, np, false, ns6, ns5, ns4, ns3, ns1);
      };

      // ベースデータの参考表そのものは行動決定に使わない。
      // 表は基準データ上の説明・検証資料として扱い、プログラム側は一般原則とDPだけで決める。
      // 6の余剰目安（ハイパー/スーパー中心: 残り回数+3、ポケ中心: 残り回数×2）は別の一般則なので維持する。
      // その二分だけを、現在の5/3在庫が残り遭遇に対して持続するかから直接判定する。
      const hasSustainableHyperOrSuperResources = (ce, s5, s3) => {
        const encounters = Math.max(1, ce);
        const hyperSustainable = s5 === -1 || Math.max(0, s5) >= Math.max(1, Math.ceil(encounters / 2));
        if (hyperSustainable) return true;
        return s3 === -1 || Math.max(0, s3) >= encounters;
      };

      // X記事の「6が余りそう」は厳密な境界ではなく目安。
      // 19以上でも6をハード禁止せず、DPで明確に有利なら閾値未満でも6を選べる。
      const s6SurplusThreshold = (ce, s5, s3) => {
        if (!hasSustainableHyperOrSuperResources(ce, s5, s3)) return Math.max(3, ce * 2);
        return Math.max(3, ce + 3);
      };

      const isS6Surplus = (ce, s6, s5, s3) => {
        if (s6 === -1) return true;
        return s6 >= s6SurplusThreshold(ce, s5, s3);
      };

      const memoKey = (cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode) => {
        if (!ctx.useNumericKey) {
          return `${cg}|${cp}|${mode}|${cChance ? 1 : 0}|${encoded('s6', s6)}|${encoded('s5', s5)}|${s4}|${encoded('s3', s3)}|${encoded('s1', s1)}|${ce}`;
        }
        let k = cg;
        k = k * ctx.radix.phase + cp;
        k = k * ctx.radix.mode + mode;
        k = k * 2 + (cChance ? 1 : 0);
        k = k * ctx.radix.s6 + encoded('s6', s6);
        k = k * ctx.radix.s5 + encoded('s5', s5);
        k = k * ctx.radix.s4 + s4;
        k = k * ctx.radix.s3 + encoded('s3', s3);
        k = k * ctx.radix.s1 + encoded('s1', s1);
        k = k * ctx.radix.enc + ce;
        return k;
      };

      const nextEncounterEV = (gCarry, s6, s5, s3, s1, ce) => {
        if (ce <= 1) return 0;
        const nextCe = ce - 1;
        const nextMode = modeForRemaining(nextCe);
        const nextBonus = bonusForMode(nextMode);
        // 将来スケジュールが2枚保証ならボーナス0枚、3枚保証なら1枚。
        // チャンスは従来どおり10%で再抽選する。
        return 0.1 * dp(gCarry, 0, 1, s6, s5, nextBonus, s3, s1, nextCe, nextMode)
             + 0.9 * dp(gCarry, 0, 0, s6, s5, nextBonus, s3, s1, nextCe, nextMode);
      };

      // 現在遭遇の捕獲確率は、DPの主目的（イベント全体の期待捕獲数）とは分離して扱う。
      // ただし期待値が同値の行動同士を比較する時だけ、使い切り資源・有限資源の判定に使う。
      const catchMemo = new Map();
      // 4 vs 3 の同値判定などで「この1手を固定した場合の当該遭遇捕獲率」を
      // 同じ状態について何度も再計算しないための専用キャッシュ。
      const forcedCatchMemo = new Map();
      // 期待値・この回の捕獲率まで同値の時だけ使う資源節約タイブレーク用。
      // 現在遭遇が終わるまでに、次回へ持ち越せる有限在庫（6/5/3/1）を何枚消費する期待値かを記録する。
      // ボーナス(s4)は使い切り資源なのでここには含めない。
      const carryoverFiniteUseMemo = new Map();
      const forcedCarryoverFiniteUseMemo = new Map();

      function policyAction(cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode) {
        if (ce <= 0 || cg >= TARGET) return -1;
        const key = memoKey(cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode);
        dp(cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode);
        return ctx.memo.getAction(key);
      }

      function policyCatchProb(cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode) {
        if (cg >= TARGET) return 1;
        if (ce <= 0) return 0;
        const k = memoKey(cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode);
        const cached = catchMemo.get(k);
        if (cached !== undefined) return cached;
        const ai = policyAction(cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode);
        if (ai < 0) { catchMemo.set(k, 0); return 0; }
        const a = actions[ai];
        const [ns6, ns5, ns4, ns3, ns1] = decrementForAction(a.id, s6, s5, s4, s3, s1);
        const np = Math.min(guarForMode(mode), cp + 1);
        const afterEat = (ng) => {
          const clamped = Math.min(TARGET, ng);
          return clamped >= TARGET ? 1 : policyCatchProb(clamped, np, 0, ns6, ns5, ns4, ns3, ns1, ce, mode);
        };
        let pEat;
        if (cChance && cp === 0) pEat = 0.10 + 0.90 * afterEat(cg + a.val * 3);
        else pEat = 0.02 + 0.08 * afterEat(cg + a.val * 3) + 0.90 * afterEat(cg + a.val);
        const eatProb = cp >= guarForMode(mode) ? 0.6 : 1.0;
        const out = eatProb * pEat;
        catchMemo.set(k, out);
        return out;
      }

      const forcedActionCatchProb = (ai, cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode) => {
        if (ai < 0 || cg >= TARGET || ce <= 0) return 0;
        const stateKey = memoKey(cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode);
        const forcedKey = `${stateKey}|${ai}`;
        const cached = forcedCatchMemo.get(forcedKey);
        if (cached !== undefined) return cached;
        const a = actions[ai];
        const [ns6, ns5, ns4, ns3, ns1] = decrementForAction(a.id, s6, s5, s4, s3, s1);
        const np = Math.min(guarForMode(mode), cp + 1);
        const afterEat = (ng) => {
          const clamped = Math.min(TARGET, ng);
          return clamped >= TARGET ? 1 : policyCatchProb(clamped, np, 0, ns6, ns5, ns4, ns3, ns1, ce, mode);
        };
        let pEat;
        if (cChance && cp === 0) pEat = 0.10 + 0.90 * afterEat(cg + a.val * 3);
        else pEat = 0.02 + 0.08 * afterEat(cg + a.val * 3) + 0.90 * afterEat(cg + a.val);
        const eatProb = cp >= guarForMode(mode) ? 0.6 : 1.0;
        const out = eatProb * pEat;
        forcedCatchMemo.set(forcedKey, out);
        return out;
      };


      function policyCarryoverFiniteUseCurrentEncounter(cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode) {
        if (cg >= TARGET || ce <= 0) return 0;
        const k = memoKey(cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode);
        const cached = carryoverFiniteUseMemo.get(k);
        if (cached !== undefined) return cached;
        const ai = policyAction(cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode);
        if (ai < 0) { carryoverFiniteUseMemo.set(k, 0); return 0; }
        const out = forcedActionCarryoverFiniteUseCurrentEncounter(ai, cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode);
        carryoverFiniteUseMemo.set(k, out);
        return out;
      }

      const forcedActionCarryoverFiniteUseCurrentEncounter = (ai, cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode) => {
        if (ai < 0 || cg >= TARGET || ce <= 0) return 0;
        const stateKey = memoKey(cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode);
        const forcedKey = `${stateKey}|${ai}`;
        const cached = forcedCarryoverFiniteUseMemo.get(forcedKey);
        if (cached !== undefined) return cached;

        const a = actions[ai];
        const finiteCost = isCarryoverFinite(a.id) ? 1 : 0;
        const [ns6, ns5, ns4, ns3, ns1] = decrementForAction(a.id, s6, s5, s4, s3, s1);
        const np = Math.min(guarForMode(mode), cp + 1);
        const afterEatCost = (ng) => {
          const clamped = Math.min(TARGET, ng);
          if (clamped >= TARGET) return finiteCost;
          return finiteCost + policyCarryoverFiniteUseCurrentEncounter(clamped, np, 0, ns6, ns5, ns4, ns3, ns1, ce, mode);
        };

        let expectedCostAfterEat;
        if (cChance && cp === 0) {
          expectedCostAfterEat = 0.10 * finiteCost
                           + 0.90 * afterEatCost(cg + a.val * 3);
        } else {
          expectedCostAfterEat = 0.02 * finiteCost
                           + 0.08 * afterEatCost(cg + a.val * 3)
                           + 0.90 * afterEatCost(cg + a.val);
        }
        // 保証外で食べなかった場合はサブレ非消費なので、有限在庫の消費も0枚。
        const eatProb = cp >= guarForMode(mode) ? 0.6 : 1.0;
        const out = eatProb * expectedCostAfterEat;
        forcedCarryoverFiniteUseMemo.set(forcedKey, out);
        return out;
      };

      // 同期待値の確定取り切り中に、直後に同じサブレを使うだけの余計な前置き投球を避ける。
      // 例: 残り4で「ポケ(1)→ボーナス+(4)」と進むなら、ボーナス+(4)を今投げて捕獲する。
      // ただし、別の有限サブレを新たに消費する最短化は行わず、既存の温存判断を維持する。
      const catchesOnMinimum = (ai, cg, cp, cChance) => {
        if (ai < 0) return false;
        const a = actions[ai];
        const minMultiplier = (cChance && cp === 0) ? 3 : 1;
        return cg + a.val * minMultiplier >= TARGET;
      };

      const forcedPathUsesAction = (forcedAi, targetId, cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode) => {
        if (forcedAi < 0) return false;
        const first = actions[forcedAi];
        let [cs6, cs5, cs4, cs3, cs1] = decrementForAction(first.id, s6, s5, s4, s3, s1);
        const minMultiplier = (cChance && cp === 0) ? 3 : 1;
        let cg2 = Math.min(TARGET, cg + first.val * minMultiplier);
        const guar = guarForMode(mode);
        let cp2 = Math.min(guar, cp + 1);
        if (cg2 >= TARGET) return false;

        while (cg2 < TARGET && cp2 < guar) {
          const nextAi = policyAction(cg2, cp2, 0, cs6, cs5, cs4, cs3, cs1, ce, mode);
          if (nextAi < 0) return false;
          const nextA = actions[nextAi];
          if (nextA.id === targetId) return true;
          [cs6, cs5, cs4, cs3, cs1] = decrementForAction(nextA.id, cs6, cs5, cs4, cs3, cs1);
          cg2 = Math.min(TARGET, cg2 + nextA.val);
          cp2 = Math.min(guar, cp2 + 1);
        }
        return false;
      };

      // 同期待値候補を探索順に依存せず一意に選ぶ完全比較器。
      // 優先順位:
      // 1) passと同値なら、保証内100%を維持できる時だけ投球を優先
      // 2) チャンス1投GET（候補同士は最小の十分なサブレ）
      // 3) 19以上・6余剰目安未満なら6温存
      // 4) 保証内100%維持
      // 5) 同じ現在回捕獲率なら、使い切り資源のボーナスを優先
      // 6) 同じ現在回捕獲率なら、持ち越し可能な有限在庫を使わずに済むルートを優先
      // 7) 不要な前置き投球を省ける場合は即時捕獲を優先
      // 8) 小さい数字順（同値の3ではボーナス優先）
      // 9) 最後は固定ID順
      // PDFの参考初手表・strategyTypeは行動決定から外し、説明・検証資料へ降格している。
      const chooseTiedAction = (candidateAis, state) => {
        let candidates = candidateAis.slice();
        if (candidates.length <= 1) return candidates[0] ?? -1;

        const {
          cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode,
          preferGuaranteedFinishOnTie, preferPreserveS6OnTie
        } = state;

        const keepsGuarantee = new Map();
        const getKeepsGuarantee = (ai) => {
          if (!preferGuaranteedFinishOnTie) return false;
          if (!keepsGuarantee.has(ai)) {
            keepsGuarantee.set(ai, actionPreservesGuaranteedFinish(mode, ai, cg, cp, cChance, s6, s5, s4, s3, s1));
          }
          return keepsGuarantee.get(ai);
        };

        const filterIfAny = (predicate) => {
          const subset = candidates.filter(predicate);
          if (subset.length > 0) candidates = subset;
        };

        // チャンス1投目で確実に届く候補があるなら、その集合を最優先。
        if (cChance && cp === 0) {
          const oneThrow = candidates.filter(ai => catchesOnMinimum(ai, cg, cp, cChance));
          if (oneThrow.length > 0) {
            candidates = oneThrow;
            const bestSmall = Math.min(...candidates.map(ai => smallActionRank(actions[ai])));
            candidates = candidates.filter(ai => smallActionRank(actions[ai]) === bestSmall);
            if (candidates.length === 1) return candidates[0];
          }
        }

        // 残り19以上・余剰目安未満で完全同値なら6を温存。
        if (preferPreserveS6OnTie) filterIfAny(ai => actions[ai].id !== 's6');

        // 保証内100%捕獲を維持できる候補があれば、その集合へ絞る。
        if (preferGuaranteedFinishOnTie) filterIfAny(ai => getKeepsGuarantee(ai));

        const catchProbMemoLocal = new Map();
        const getCatchProb = (ai) => {
          if (!catchProbMemoLocal.has(ai)) {
            catchProbMemoLocal.set(ai, forcedActionCatchProb(ai, cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode));
          }
          return catchProbMemoLocal.get(ai);
        };
        const allSameCatchProb = () => {
          if (candidates.length <= 1) return true;
          let minP = Infinity, maxP = -Infinity;
          for (const ai of candidates) {
            const p = getCatchProb(ai);
            if (p < minP) minP = p;
            if (p > maxP) maxP = p;
          }
          return maxP - minP <= EPS;
        };

        // ボーナスは有限在庫ではなく、その遭遇で使わなければ消える「使い切り資源」。
        // イベント期待値と現在回捕獲率が同じなら、持ち越せる資源より先に消化する。
        if (candidates.length > 1 && allSameCatchProb()) {
          filterIfAny(ai => isExpiringBonus(actions[ai].id));
        }

        // 同じ現在回捕獲率なら、持ち越し可能な有限在庫を一切使わずに済むルートを優先。
        if (candidates.length > 1 && allSameCatchProb()) {
          const costs = new Map();
          for (const ai of candidates) {
            costs.set(ai, forcedActionCarryoverFiniteUseCurrentEncounter(ai, cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode));
          }
          const hasZero = candidates.some(ai => costs.get(ai) <= EPS);
          const hasPositive = candidates.some(ai => costs.get(ai) > EPS);
          if (hasZero && hasPositive) candidates = candidates.filter(ai => costs.get(ai) <= EPS);
        }

        // 同じ資源原則まで並んだ場合のみ、直後に同じサブレを使う余計な前置き投球を省く。
        if (candidates.length > 1 && preferGuaranteedFinishOnTie && !cChance) {
          const immediate = candidates.filter(ai => catchesOnMinimum(ai, cg, cp, cChance));
          const nonImmediate = candidates.filter(ai => !catchesOnMinimum(ai, cg, cp, cChance));
          if (immediate.length > 0 && nonImmediate.length > 0) {
            const usefulImmediate = immediate.filter(nowAi =>
              nonImmediate.some(otherAi => forcedPathUsesAction(otherAi, actions[nowAi].id, cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode))
            );
            if (usefulImmediate.length > 0) candidates = usefulImmediate;
          }
        }

        // 一般原則として最後は小さい数字順。同じ3ならボーナスを先にする。
        const bestSmall = Math.min(...candidates.map(ai => smallActionRank(actions[ai])));
        candidates = candidates.filter(ai => smallActionRank(actions[ai]) === bestSmall);
        if (candidates.length === 1) return candidates[0];

        // 完全に同じ場合でも配列の探索順へ戻らないよう、固定ID順で必ず一意化する。
        candidates.sort((x, y) => stableActionRank(actions[x]) - stableActionRank(actions[y]));
        return candidates[0];
      };

      function dp(cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode) {
        if (ce <= 0) return 0;

        if (cg >= TARGET) {
          return 1 + nextEncounterEV(0, s6, s5, s3, s1, ce);
        }

        const key = memoKey(cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode);
        const hit = ctx.memo.getEV(key);
        if (hit !== undefined) return hit;

        const passEV = nextEncounterEV(cg, s6, s5, s3, s1, ce);

        // 分割睡眠2回目（2枚保証）でも、保証終了後は強制終了しない。
        // 2枚で届かなかった場合は「次の通常3枚保証へ持ち越す」passEV と、
        // 満腹リスクを取って追加で投げる各行動を同じDPで比較し、
        // イベント全体の期待捕獲数が高い方を選ぶ。

        const standardThreeGuaranteeMode = isStandardThreeGuaranteeMode(mode);
        const guar = guarForMode(mode);
        // 通常3枚保証・分割2枚保証のどちらでも、現状態から保証内100%捕獲が可能かを判定する。
        // これはハード制約ではなく、期待値同値時の優先判定にだけ使う。
        const guaranteedFinish = canGuaranteeCatch(mode, cg, cp, cChance, s6, s5, s4, s3, s1);

        const remainingGauge = TARGET - cg;
        const normalNonChance = !cChance;

        // 保証内100%捕獲はハード制約にせず、イベント全体の期待捕獲数を最優先する。
        // 期待値が同値の候補同士では、ベースデータの「保証内に届くなら捕まえ切るのが基本」に合わせ、
        // 通常成功だけでも残り保証内100%捕獲を維持できる行動を優先する。
        const preferGuaranteedFinishOnTie = guaranteedFinish;

        // 残り19以上の「6温存」はベースデータでも基本方針・目安であり、厳密な境界ではない。
        // そのため6を候補からハード除外せず、全候補をDPで比較する。期待値が同じ時だけ、
        // 最終遭遇ではなく、かつ余剰目安未満なら6を使わない方を優先する。
        const inS6PreserveZone = standardThreeGuaranteeMode
          && normalNonChance
          && remainingGauge >= 19
          && ce > 1;
        const preferPreserveS6OnTie = inS6PreserveZone
          && countAvailable(s6)
          && !isS6Surplus(ce, s6, s5, s3);

        // 翌日送りも含めて全候補を期待値比較する。保証内捕獲は候補の除外条件にしない。
        // まず全候補の期待値を計算し、その後で同期待値候補だけを完全比較器へ渡す。
        // これにより actions 配列の列挙順を変えても推奨行動は変わらない。
        let bestEV = passEV;
        const actionEVs = [];
        const eatProb = cp >= guarForMode(mode) ? 0.6 : 1.0;

        for (let ai = 0; ai < actions.length; ai++) {
          const a = actions[ai];
          const count = getCount(a.id, s6, s5, s4, s3, s1);
          if (count === 0) continue;

          const [ns6, ns5, ns4, ns3, ns1] = decrementForAction(a.id, s6, s5, s4, s3, s1);
          const np = Math.min(guar, cp + 1);

          const evAfterEat = (ng) => {
            const clamped = Math.min(TARGET, ng);
            if (clamped >= TARGET) {
              return 1 + nextEncounterEV(0, ns6, ns5, ns3, ns1, ce);
            }
            return dp(clamped, np, 0, ns6, ns5, ns4, ns3, ns1, ce, mode);
          };

          let eatEV;
          if (cChance && cp === 0) {
            eatEV = 0.10 * evAfterEat(TARGET)
                  + 0.90 * evAfterEat(cg + a.val * 3);
          } else {
            eatEV = 0.02 * evAfterEat(TARGET)
                  + 0.08 * evAfterEat(cg + a.val * 3)
                  + 0.90 * evAfterEat(cg + a.val);
          }

          // 食べなかった場合はサブレ非消費でその出会いだけ終了。
          const expectedValue = eatProb * eatEV + (1 - eatProb) * passEV;
          actionEVs.push([ai, expectedValue]);
          if (expectedValue > bestEV) bestEV = expectedValue;
        }

        const passTied = Math.abs(passEV - bestEV) <= EPS;
        let tiedAis = actionEVs
          .filter(([, ev]) => Math.abs(ev - bestEV) <= EPS)
          .map(([ai]) => ai);
        let bestAction = -2;

        if (passTied) {
          // 期待値が「次回へ送る」と同じ時は、保証内100%を維持できる行動がある場合だけ投球を優先。
          // それ以外は従来どおりpassを維持する。
          if (preferGuaranteedFinishOnTie) {
            const guaranteedTied = tiedAis.filter(ai =>
              actionPreservesGuaranteedFinish(mode, ai, cg, cp, cChance, s6, s5, s4, s3, s1)
            );
            if (guaranteedTied.length > 0) tiedAis = guaranteedTied;
            else tiedAis = [];
          } else {
            tiedAis = [];
          }
        }

        if (tiedAis.length > 0) {
          bestAction = chooseTiedAction(tiedAis, {
            cg, cp, cChance, s6, s5, s4, s3, s1, ce, mode,
            preferGuaranteedFinishOnTie, preferPreserveS6OnTie
          });
        }

        ctx.memo.set(key, bestEV, bestAction);
        return bestEV;
      }

      // 捕獲済み／満腹直後は、現在の出会いを終了済みとして「次回以降」だけの期待値を返す。
      // 残り出会い回数はUI上まだ現在回を含むため、ここで1回だけ減らす。
      const encounterEnded = !!input.encounterEnded || g >= TARGET;
      if (encounterEnded) {
        let futureEV = 0;
        if (enc > 1) {
          const carryG = g >= TARGET ? 0 : g;
          const nextCe = enc - 1;
          const nextMode = modeForRemaining(nextCe);
          const nextBonus = bonusForMode(nextMode);
          futureEV = 0.1 * dp(carryG, 0, 1, startInv.s6, startInv.s5, nextBonus, startInv.s3, startInv.s1, nextCe, nextMode)
                   + 0.9 * dp(carryG, 0, 0, startInv.s6, startInv.s5, nextBonus, startInv.s3, startInv.s1, nextCe, nextMode);
        }
        return {
          ev: futureEV,
          catchProb: 0,
          action: null,
          route: [],
          finalG: g,
          memoStates: ctx.memo.size,
          numericMemoKey: ctx.useNumericKey,
          encounterEnded: true
        };
      }

      const baseEV = dp(
        g, phase, chance ? 1 : 0,
        startInv.s6, startInv.s5, startInv.s4, startInv.s3, startInv.s1, enc, startMode
      );
      const baseAction = policyAction(
        g, phase, chance ? 1 : 0,
        startInv.s6, startInv.s5, startInv.s4, startInv.s3, startInv.s1, enc, startMode
      );

      // 「通常成功・満腹なし進行時」の表示用ルートもWorker内で作り、
      // 同じメモを使い回してメインスレッド側の再計算をゼロにする。
      const route = [];
      let rg = g;
      let rp = phase;
      let rMode = startMode;
      let rChance = chance;
      let rs6 = startInv.s6, rs5 = startInv.s5, rs4 = startInv.s4, rs3 = startInv.s3, rs1 = startInv.s1;

      for (let guard = 0; rg < TARGET && guard < 40; guard++) {
        const ai = policyAction(rg, rp, rChance ? 1 : 0, rs6, rs5, rs4, rs3, rs1, enc, rMode);
        if (ai < 0) break;
        const a = actions[ai];
        route.push(a.name);

        if (a.id === 's6' && rs6 !== -1) rs6--;
        else if (a.id === 's5' && rs5 !== -1) rs5--;
        else if (a.id === 's4' && rs4 !== -1) rs4--;
        else if (a.id === 's3' && rs3 !== -1) rs3--;
        else if (a.id === 's1' && rs1 !== -1) rs1--;

        rg += a.val * (rChance ? 3 : 1);
        rp = Math.min(guarForMode(rMode), rp + 1);
        rChance = false;
      }

      let action = null;
      if (baseAction >= 0) action = actions[baseAction];
      else if (baseAction === -2) action = { id: 'pass', val: 0, name: '➔ 翌日へ (ストップ)' };

      return {
        ev: baseEV,
        catchProb: policyCatchProb(g, phase, chance ? 1 : 0, startInv.s6, startInv.s5, startInv.s4, startInv.s3, startInv.s1, enc, startMode),
        action,
        route,
        finalG: rg,
        memoStates: ctx.memo.size,
        numericMemoKey: ctx.useNumericKey
      };
    }
  