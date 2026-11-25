"""Create a separate reproducible experiment from the frozen prior sources."""
import pathlib,json
HERE=pathlib.Path(__file__).resolve().parent
BASE=HERE.parent/'two-stage-policy-2026-11-14'
paths=json.loads((BASE/'paths.json').read_text())
cache=pathlib.Path(paths['external_linux']).parent/HERE.name
cache.mkdir(parents=True,exist_ok=True)
out={'external_linux':str(cache),'base_linux':paths['external_linux'],
     'targets_linux':str(cache.parent/'two-stage-directions-2026-11-14')}
(HERE/'paths.json').write_text(json.dumps(out,indent=2))
spec=json.loads((BASE/'spec.json').read_text())
spec.update({
 'objective':'Independent side-conditioned entry/news and exit/no-news supervised networks for >=+10% bullish and <=-10% bearish historical24h moves.',
 'target_definition':'Use the separately validated two-direction teachers. Separate24h anchor cooldown per side; maximize linear gross return in that direction over prior24h entry choices and5m..24h exits. Neighbors within5m retaining95% of optimum are positive. Future rally membership/direction are never input features.',
 'candidate_rules':'Evaluate both candidate sides at each eligible5m state. One position per symbol. Pick the highest entry score among sides crossing the validation-selected threshold; exact score ties wait. Candidate side is known before choosing a trade, not an observed future rally direction.',
 'entry_inputs':'Causal market features, explicit eight SMA pairs and crossover state, candidate side, and only contemporaneously available structured asset-relevant news. Numeric confidence is evidence quality, not a price probability.',
 'exit_inputs':'Causal market/SMA features, actual position side and side-adjusted trade state. No news or entry score/latent.',
 'news_policy':'Use immutable event revisions and referenced evidence as-of each decision. Require direct/indirect target with mechanism and non-none channel, matching native underlying symbol and asset/perp instrument kind. Exclude market/venue/collateral/unresolved and spot-only mappings from asset news. Do not infer direction for indirect or ambiguous multi-asset impact. Include mixed and direction-unspecified buckets. Fixed topic taxonomy; preserve scalars and categorical indicators separately.',
 'training':'Balanced BCE for both binary action models. Sample long/short and positive/negative strata equally when all exist. Entry checkpoint selected by mean per-side validation AP. Exit checkpoint/threshold selected by mean validation teacher-entry return averaged across sides.4,000 updates per network. No duration regression.',
 'selection':'Earlier chronological validation only. Shared entry threshold[.5,.75,.9]; shared exit threshold[.25,.5,.75]. Cash allowed. Separate model weights; eight SMA pairs fixed/configurable, not separately optimized period hyperparameters.',
 'splitting':'Keep original outer windows and48h32m label maturity plus24h purge. Inner validation latest2 eligible dates, expand backwards until>=5 positives for EACH side. All target sides at the same timestamp share a split. Earlier periods were researched before; unseen to each fitted model, not pristine research holdouts.',
 'deployment':'Offline research artifacts only. No orders or activation. Prior experiments unchanged.',
 'side_labels':['long','short'],
 'comparison':'Prior long-only run is a reference, not a controlled news/SMA ablation because targets/features/directions all change.'
})
spec['economics']['terminal_retry_minutes']=0
spec['holding_deadline_policy']='Strict1440 minutes after actual entry fill. Missing exact-deadline price is censored, never filled later. Reoptimize the same accepted rally windows using only observed exits within the deadline.'
(HERE/'spec.json').write_text(json.dumps(spec,indent=2))
text=(BASE/'common_two.py').read_text()
text=text.replace("CACHE.mkdir(parents=True,exist_ok=True)","CACHE.mkdir(parents=True,exist_ok=True)\nBASE=HERE.parent/'two-stage-policy-2026-11-14';BASE_CACHE=pathlib.Path(PATHS['base_linux']);TARGETS=pathlib.Path(PATHS['targets_linux'])")
text=text.replace("CACHE/'candles'","BASE_CACHE/'candles'")
(HERE/'common.py').write_text(text)
text=(BASE/'model_two.py').read_text().replace('from dataset_two import *','from dataset import *')
text=text.replace('def fit(self,x,y,callback):','def fit(self,x,y,callback,sides=None):')
text=text.replace('losses=[]','losses=[]\n        groups=[np.flatnonzero((y==label)&(sides==side)) for side in [-1,1] for label in [0,1]] if sides is not None else [negative,positive]\n        assert all(len(g) for g in groups), "Every training side needs positive and negative targets"')
text=text.replace("half=cfg['batch']//2;idx=np.r_[self.rng.choice(positive,half),self.rng.choice(negative,half)]", "idx=np.concatenate([self.rng.choice(g,cfg['batch']//len(groups)) for g in groups])")
(HERE/'model.py').write_text(text)
print(json.dumps({'experiment':str(HERE),'cache':str(cache),'sma_pairs':spec['sma_pairs']}))
