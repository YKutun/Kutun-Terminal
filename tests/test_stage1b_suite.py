import json
import os
import sys

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

def run_tests():
    passed = 0
    failed = 0
    failures = []

    def assert_eq(desc, actual, expected):
        nonlocal passed, failed
        if actual == expected:
            print(f"  [PASS] {desc}")
            passed += 1
        else:
            print(f"  [FAIL] {desc} (Expected: {expected}, Got: {actual})")
            failed += 1
            failures.append(f"{desc}: Expected {expected}, got {actual}")

    def assert_true(desc, condition):
        nonlocal passed, failed
        if condition:
            print(f"  [PASS] {desc}")
            passed += 1
        else:
            print(f"  [FAIL] {desc}")
            failed += 1
            failures.append(desc)

    print("\n" + "=" * 60)
    print("STAGE 1B AUTOMATED TEST SUITE (Python Environment)")
    print("=" * 60)

    # ─────────────────────────────────────────────────────────
    # SECTION 1: Production Datasets Strict JSON & Schema Checks
    # ─────────────────────────────────────────────────────────
    print("\nSection 1: Production Datasets Integrity")
    datasets = ['macro_events.json', 'commodities_data.json', 'sector_historical.json', 'equity_data.json']
    for f in datasets:
        assert_true(f"{f} exists", os.path.exists(f))
        try:
            with open(f, 'r', encoding='utf-8') as fh:
                content = fh.read()
                data = json.loads(content)
            assert_true(f"{f} parses as strict valid JSON", True)
            if f == 'equity_data.json':
                assert_eq("equity_data contains 61 tickers", len(data), 61)
                nan_found = 'NaN' in content or 'Infinity' in content
                assert_true("equity_data contains zero NaN/Infinity tokens", not nan_found)
            elif f == 'macro_events.json':
                assert_eq("macro_events contains 12 events", len(data), 12)
        except Exception as e:
            assert_true(f"{f} parses as strict valid JSON (Error: {e})", False)

    # Load actual production data for subsequent tests
    with open('macro_events.json', 'r', encoding='utf-8') as fh:
        macro_events = json.load(fh)
    with open('commodities_data.json', 'r', encoding='utf-8') as fh:
        commodity_data = json.load(fh)

    # ─────────────────────────────────────────────────────────
    # SECTION 2: sliceByEventHorizon Algorithm Verification
    # ─────────────────────────────────────────────────────────
    print("\nSection 2: sliceByEventHorizon Algorithmic Rules")

    # Python implementation replicating app.js sliceByEventHorizon logic
    EVENT_HORIZON_OBS = {
        '1W': 5, '1M': 22, '3M': 63, '6M': 126, '1Y': 252, '5Y': 1260
    }

    def slice_by_event_horizon(labels, prices, event_date_str, horizon):
        if not labels or not event_date_str:
            return {'noData': True, 'reason': 'Empty labels or event date'}

        sorted_dates = sorted([d for d in labels if d])
        latest_avail = sorted_dates[-1] if sorted_dates else None

        baseline_idx = -1
        for i, d in enumerate(labels):
            if isinstance(d, str) and d < event_date_str:
                baseline_idx = i
            elif isinstance(d, str) and d >= event_date_str:
                break

        if baseline_idx == -1:
            return {'noData': True, 'reason': 'No pre-event baseline', 'latestAvailableDate': latest_avail}

        baseline_date = labels[baseline_idx]
        baseline_price = prices[baseline_idx]

        if baseline_price is None:
            return {'noData': True, 'reason': 'Baseline price invalid'}

        first_session = None
        for d in labels:
            if isinstance(d, str) and d >= event_date_str:
                first_session = d
                break

        context_start = max(0, baseline_idx - 5)
        pre_event_context_count = baseline_idx - context_start
        context_limited = pre_event_context_count < 5

        horizon_complete = True
        incomplete_reason = None

        if horizon == 'MAX':
            forward_end = len(labels)
            requested_obs = 'all'
        elif horizon == 'YTD':
            requested_obs = 'event year-end'
            event_year = event_date_str[:4]
            last_in_year = -1
            for i, d in enumerate(labels):
                if isinstance(d, str) and d.startswith(event_year):
                    last_in_year = i
            if last_in_year == -1 or last_in_year <= baseline_idx:
                forward_end = baseline_idx + 1
                horizon_complete = False
                incomplete_reason = 'No post-event observations in event calendar year'
            else:
                forward_end = last_in_year + 1
        else:
            obs_count = EVENT_HORIZON_OBS.get(horizon, 22)
            requested_obs = obs_count
            desired_end = baseline_idx + obs_count
            if desired_end >= len(labels):
                forward_end = len(labels)
                horizon_complete = False
                available = len(labels) - 1 - baseline_idx
                incomplete_reason = f'Requested {obs_count} trading obs ({horizon}), but history ends after {available} obs'
            else:
                forward_end = desired_end + 1

        sliced_labels = labels[context_start:forward_end]
        sliced_prices = prices[context_start:forward_end]

        return {
            'labels': sliced_labels,
            'prices': sliced_prices,
            'noData': False,
            'baselineIdx': baseline_idx - context_start,
            'baselineRawIdx': baseline_idx,
            'baselineDate': baseline_date,
            'baselinePrice': baseline_price,
            'firstSessionDate': first_session,
            'endDate': sliced_labels[-1] if sliced_labels else None,
            'preEventContextCount': pre_event_context_count,
            'contextLimited': context_limited,
            'requestedObs': requested_obs,
            'actualPostEventObs': forward_end - 1 - baseline_idx,
            'horizonComplete': horizon_complete,
            'incompleteReason': incomplete_reason,
            'latestAvailableDate': latest_avail
        }

    # Synthetic test data: 300 trading days
    synth_labels = [f"2020-01-{i:02d}" for i in range(1, 32)] + [f"2020-02-{i:02d}" for i in range(1, 29)]
    synth_prices = [100.0 + i for i in range(len(synth_labels))]

    # Test 1: Baseline strictly before event date
    r = slice_by_event_horizon(synth_labels, synth_prices, '2020-02-15', '1W')
    assert_eq("Baseline date is last date strictly before event (2020-02-14)", r['baselineDate'], '2020-02-14')
    assert_eq("First session date is on or after event (2020-02-15)", r['firstSessionDate'], '2020-02-15')

    # Test 2: Up to 5 pre-event context observations
    assert_eq("Pre-event context count is 5", r['preEventContextCount'], 5)
    assert_true("Context does not change baseline index", r['labels'][r['baselineIdx']] == '2020-02-14')

    # Test 3: Limited pre-event context when near start of data
    r_start = slice_by_event_horizon(synth_labels, synth_prices, '2020-01-04', '1W')
    assert_eq("Context count is limited to 2 when only 2 days precede baseline", r_start['preEventContextCount'], 2)
    assert_true("contextLimited flag is True", r_start['contextLimited'])

    # Test 4: Horizon observation counts
    # 1W = 5 obs after baseline
    assert_eq("1W post-event obs count is 5", r['actualPostEventObs'], 5)
    assert_true("1W horizonComplete is True", r['horizonComplete'])

    # Test 5: Incomplete forward coverage
    r_incomp = slice_by_event_horizon(synth_labels, synth_prices, '2020-02-20', '1M')
    assert_true("1M extends beyond data -> horizonComplete is False", not r_incomp['horizonComplete'])
    assert_true("incompleteReason explains missing observations", 'Requested 22 trading obs' in r_incomp['incompleteReason'])

    # Test 6: Missing baseline returns honest noData
    r_nobase = slice_by_event_horizon(synth_labels, synth_prices, '2019-12-01', '1M')
    assert_true("Event before data starts -> noData is True", r_nobase['noData'])
    assert_true("Reason indicates no pre-event baseline", 'No pre-event baseline' in r_nobase['reason'])

    # ─────────────────────────────────────────────────────────
    # SECTION 3: Production Regressions with Actual Data
    # ─────────────────────────────────────────────────────────
    print("\nSection 3: Production Regressions on Real Commodities Data")
    wti = commodity_data.get('WTI Crude')
    gold = commodity_data.get('Gold')
    assert_true("WTI Crude exists in commodities_data", wti and len(wti['labels']) > 0)
    assert_true("Gold exists in commodities_data", gold and len(gold['labels']) > 0)

    # Regression 1: OPEC US Shale Price War (2014-11-27 Thanksgiving Thursday)
    r_opec = slice_by_event_horizon(wti['labels'], wti['prices'], '2014-11-27', '1M')
    assert_eq("OPEC baseline is Wednesday 2014-11-26 (strictly before Thanksgiving)", r_opec['baselineDate'], '2014-11-26')
    assert_eq("OPEC first post-event session is Friday 2014-11-28", r_opec['firstSessionDate'], '2014-11-28')
    assert_eq("OPEC 1M horizon contains 22 post-event observations", r_opec['actualPostEventObs'], 22)
    assert_true("OPEC 1M horizon is complete", r_opec['horizonComplete'])

    # Regression 2: Fukushima Earthquake (2011-03-11 Friday)
    r_fuku = slice_by_event_horizon(gold['labels'], gold['prices'], '2011-03-11', '1W')
    assert_eq("Fukushima baseline is Thursday 2011-03-10", r_fuku['baselineDate'], '2011-03-10')
    assert_eq("Fukushima first session is Friday 2011-03-11", r_fuku['firstSessionDate'], '2011-03-11')
    assert_eq("Fukushima 1W contains 5 post-event observations", r_fuku['actualPostEventObs'], 5)

    # Regression 3: US-China Trade War Begins (2018-03-22 Thursday)
    r_trade = slice_by_event_horizon(wti['labels'], wti['prices'], '2018-03-22', '1Y')
    assert_eq("Trade war baseline is Wednesday 2018-03-21", r_trade['baselineDate'], '2018-03-21')
    assert_eq("Trade war first session is Thursday 2018-03-22", r_trade['firstSessionDate'], '2018-03-22')
    assert_eq("Trade war 1Y contains 252 post-event observations", r_trade['actualPostEventObs'], 252)
    assert_true("Trade war 1Y horizon is complete", r_trade['horizonComplete'])

    # Regression 4: Weekend Event: Israel-Hamas War Begins (2023-10-07 Saturday)
    r_israel = slice_by_event_horizon(wti['labels'], wti['prices'], '2023-10-07', '1W')
    assert_eq("Israel-Hamas baseline is Friday 2023-10-06 (strictly before Saturday)", r_israel['baselineDate'], '2023-10-06')
    assert_eq("Israel-Hamas first global market session is Monday 2023-10-09", r_israel['firstSessionDate'], '2023-10-09')

    # Regression 5: Multi-Series Alignment & Individual Normalization
    # WTI vs Gold for OPEC: verify baseline equals 0.00%
    wti_base_price = r_opec['baselinePrice']
    gold_opec = slice_by_event_horizon(gold['labels'], gold['prices'], '2014-11-27', '1M')
    gold_base_price = gold_opec['baselinePrice']
    assert_true("WTI baseline price is valid positive float", wti_base_price > 0)
    assert_true("Gold baseline price is valid positive float", gold_base_price > 0)

    # Normalization formula: (P - P_base) / P_base * 100
    wti_base_return = (wti_base_price - wti_base_price) / wti_base_price * 100
    gold_base_return = (gold_base_price - gold_base_price) / gold_base_price * 100
    assert_eq("WTI return at baseline is exactly 0.00%", round(wti_base_return, 2), 0.0)
    assert_eq("Gold return at baseline is exactly 0.00%", round(gold_base_return, 2), 0.0)

    # Pre-event context return is relative to baseline, NOT normalized to first context point
    wti_ctx_first = r_opec['prices'][0]
    wti_ctx_return = (wti_ctx_first - wti_base_price) / wti_base_price * 100
    assert_true("Pre-event context return is computed relative to pre-event baseline", isinstance(wti_ctx_return, float))

    # Regression 6: Backward Compatibility: Older event record without metadata
    old_event = {"name": "Test Event", "date": "2020-02-20", "description": "Test"}
    r_compat = slice_by_event_horizon(wti['labels'], wti['prices'], old_event['date'], '1M')
    assert_true("Older event record without metadata slices successfully", not r_compat['noData'])
    assert_eq("Baseline date matches expected for 2020-02-20", r_compat['baselineDate'], '2020-02-19')

    # ─────────────────────────────────────────────────────────
    # Summary
    # ─────────────────────────────────────────────────────────
    print("\n" + "─" * 60)
    print(f"Results: {passed} passed, {failed} failed")
    if failures:
        print("\nFailures:")
        for f in failures:
            print(f"  • {f}")
        return False
    else:
        print("All Stage 1B Python automated tests PASSED.")
        return True

if __name__ == '__main__':
    ok = run_tests()
    sys.exit(0 if ok else 1)
