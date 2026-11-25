"""Direction-specific research labels, without changing or retraining the old models.

Reuse the frozen source candles and execution/eligibility rules. Columns are
long, short. A short is a linear unlevered return on entry notional, not an
inverse-price return. Instrument short availability is not established here.
"""
import sys
from pathlib import Path
OUT = Path(__file__).resolve().parent
SOURCE = OUT.parent / 'two-stage-policy-2026-11-14'
sys.path.insert(0, str(SOURCE))
from common_two import CACHE, SPEC, MIN, BAR, H, ms, iso, safe, future_best
import numpy as np
import json, hashlib, collections

DEST = CACHE.parent / OUT.name
SIDES = [('bullish', 'long', 1), ('bearish', 'short', -1)]

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False), encoding='utf-8')

def side_oracle(price, terminal, sign):
    # Maximizing signed price finds the maximum for a long and minimum for a short.
    signed, index = future_best(sign * price)
    terminal_better = np.isfinite(terminal) & (~np.isfinite(signed) | (sign * terminal > signed))
    signed[terminal_better] = sign * terminal[terminal_better]
    index[terminal_better] = np.arange(len(price))[terminal_better] + H
    return sign * signed, index, 100 * sign * (safe(sign * signed, price) - 1)

def main():
    catalog = json.loads((SOURCE / 'catalog.json').read_text())
    old_teachers = json.loads((CACHE / 'teachers.json').read_text())
    stats = {side: collections.Counter() for _, side, _ in SIDES}
    exclusions = {side: collections.Counter() for _, side, _ in SIDES}
    teachers, target_catalog = [], []
    source_hash, output_hash = hashlib.sha256(), hashlib.sha256()
    label_folder = DEST / 'labels'
    label_folder.mkdir(parents=True, exist_ok=True)
    for c in catalog:
        source_file = CACHE / 'bars' / (c['key'] + '.npz')
        digest = hashlib.sha256(source_file.read_bytes()).hexdigest()
        source_hash.update((c['key'] + ':' + digest).encode())
        with np.load(source_file) as z:
            price, terminal, terminal_time = z['price'], z['terminal_price'], z['terminal_time']
            ret24, eligible, mature = z['rolling24h_gain_pct'], z['eligible'], z['mature']
            n = len(price)
            targets = np.zeros((n, 2), np.float32)
            gains = np.full((n, 2), np.nan)
            exits = np.full((n, 2), -1, np.int32)
            offset, start, end = c['offset'], ms(c['start']), ms(c['end'])
            for column, (direction, side, sign) in enumerate(SIDES):
                _, best_exit, gain = side_oracle(price, terminal, sign)
                gains[:, column], exits[:, column] = gain, best_exit
                qualifying = np.flatnonzero(sign * ret24 >= SPEC['rally_gain_24h_pct'])
                stats[side]['qualifying_5m_observations'] += len(qualifying)
                next_anchor = 0
                uncertain = np.zeros(n, bool)
                for anchor in qualifying:
                    if anchor < next_anchor:
                        continue
                    next_anchor = anchor + H
                    stats[side]['deduplicated_anchors'] += 1
                    if start + (int(anchor) + 1) * BAR + 1472 * MIN > end:
                        exclusions[side]['unfinished_rally_teacher_horizon'] += 1
                        continue
                    window = np.arange(max(H, int(anchor) - H), int(anchor) + 1)
                    candidates = window[eligible[window] & np.isfinite(price[window])]
                    if not len(candidates):
                        exclusions[side]['no_liquid_executable_teacher_entry'] += 1
                        continue
                    if not np.isfinite(terminal[candidates]).all():
                        exclusions[side]['unresolved_teacher_search_terminal'] += 1
                        uncertain[window] = True
                        continue
                    entry = int(candidates[np.argmax(gain[candidates])])
                    optimum = float(gain[entry])
                    if optimum <= 0:
                        exclusions[side]['no_positive_executable_teacher_gain'] += 1
                        continue
                    near = candidates[(abs(candidates - entry) <= SPEC['target_entry_tolerance_bars']) &
                                      (gain[candidates] >= SPEC['target_entry_relative_profit'] * optimum)]
                    targets[near, column] = 1
                    exit_index = int(best_exit[entry])
                    teachers.append({
                        'id':len(teachers), 'direction':direction, 'side':side, 'side_sign':sign,
                        'series':c['id'], 'symbol':c['symbol'], 'period':c['period'],
                        'anchor_index':offset + int(anchor), 'anchor_time':iso(start + (int(anchor) + 1) * BAR),
                        'rolling24h_gain_pct':float(ret24[anchor]),
                        'teacher_entry':offset + entry, 'teacher_entry_time':iso(start + (entry + 1) * BAR + MIN),
                        'teacher_exit':offset + exit_index,
                        'teacher_exit_time':iso(int(terminal_time[entry])) if exit_index == entry + H else iso(start + (exit_index + 1) * BAR + MIN),
                        'teacher_gain_pct':optimum,
                        'label_available':iso(start + (int(anchor) + 1) * BAR + 1472 * MIN),
                        'positive_entry_indices':(offset + near).tolist()
                    })
                    stats[side]['teacher_rallies'] += 1
                targets[uncertain & (targets[:, column] == 0), column] = np.nan
                valid = eligible & mature & np.isfinite(price) & np.isfinite(targets[:, column])
                stats[side]['mature_executable_labeled_states'] += int(valid.sum())
                stats[side]['mature_executable_good_entry_states'] += int((valid & (targets[:, column] == 1)).sum())
            file = label_folder / (c['key'] + '.npz')
            np.savez_compressed(file, entry_target=targets, oracle_gain=gains, oracle_exit_local_index=exits,
                                eligible=eligible, mature=mature, side_sign=np.array([1, -1], np.int8))
            output_digest = hashlib.sha256(file.read_bytes()).hexdigest()
            output_hash.update((c['key'] + ':' + output_digest).encode())
            target_catalog.append({**c, 'label_file':str(file), 'label_sha256':output_digest, 'source_sha256':digest})
        if (c['id'] + 1) % 100 == 0:
            print(json.dumps({'series_done':c['id']+1, 'teachers':{k:v['teacher_rallies'] for k,v in stats.items()}}), flush=True)
    # A new bearish pass must not silently alter the original bullish experiment.
    old = {(e['series'],e['anchor_index']):e for e in old_teachers}
    longs = [e for e in teachers if e['side']=='long']
    assert len(old) == len(longs)
    compare = ['teacher_entry','teacher_exit','teacher_exit_time','positive_entry_indices','label_available']
    for e in longs:
        prior=old[(e['series'],e['anchor_index'])]
        assert all(e[k]==prior[k] for k in compare)
        assert np.isclose(e['teacher_gain_pct'],prior['teacher_gain_pct'],rtol=1e-12,atol=1e-12)
    for _,side,_ in SIDES:
        selected=[e for e in teachers if e['side']==side]
        stats[side]['unique_teacher_entries']=len({e['teacher_entry'] for e in selected})
        stats[side]['teacher_symbols']=len({e['symbol'] for e in selected})
        stats[side]['all_positive_entry_points']=len({i for e in selected for i in e['positive_entry_indices']})
    summary={
        'status':'targets_generated_models_not_retrained',
        'source_cutoff':SPEC['periods'][-1]['end'], 'scanned_symbols':len({c['symbol'] for c in catalog}),
        'series':len(catalog),'global_states':sum(c['bars'] for c in catalog),
        'directions':{k:dict(v) for k,v in stats.items()}, 'exclusions':{k:dict(v) for k,v in exclusions.items()},
        'original_bullish_teachers_reproduced':len(longs),
        'source_bars_sha256':source_hash.hexdigest(),'labels_sha256':output_hash.hexdigest(),
        'generator_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'target_rule':'24h return >=+10% for long, <=-10% for short; separate 24h cooldown per token and side. Best entry in prior24h through anchor; best direction-adjusted exit5m..24h after entry. Neighbors within5m must retain95% of best return.',
        'gross_return_pct':'100 * side_sign * (exit_price / entry_price - 1), side_sign long=+1 short=-1',
        'fees':0,'funding_payments':0,'slippage':0,
        'label_contract':'Columns [long,short]. Each cell is a separate enter/not-enter target. Query side is an explicit candidate input; future rally direction is never supplied as a feature. Exit targets are CLOSE at/after the side-specific optimum, HOLD before it, on the same positive entry points. The old training/runtime must not load these labels without side-aware changes.',
        'limitations':['Hindsight labels are not realized performance.','No short borrowing, margin, liquidation or historical instrument-availability checks.','Retains original5m execution and terminal retry up to30m after24h.','Original model artifacts and scores remain long-only.'],
        'external_output':str(DEST)
    }
    write_json(DEST/'teachers.json',teachers)
    write_json(OUT/'catalog.json',target_catalog)
    write_json(OUT/'target-summary.json',summary)
    write_json(OUT/'target-spec.json',{
        'objective':'Bullish and bearish target generation only; no model retraining.',
        'target_definition':summary['target_rule'],'target_sides':['long','short'],
        'source_experiment':str(SOURCE),'source_spec_sha256':hashlib.sha256((SOURCE/'spec.json').read_bytes()).hexdigest(),
        'periods':SPEC['periods'],'economics':SPEC['economics'],'bar_minutes':5,
        'holding_limit_minutes':1440,'anchor_cooldown_minutes_per_side':1440,
        'entry_label_maturity_minutes':2912,'required_split_purge_minutes':1440,
        'entry_target_columns':['long','short'],'exit_target':'CLOSE at/after side-specific optimum, HOLD before it; force CLOSE at step288.',
        'training_status':'Not trained. Existing models are long-only; their runtime cannot consume the new direction labels.'
    })
    print(json.dumps(summary),flush=True)

if __name__=='__main__':
    main()
