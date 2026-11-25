"""Create a news-only ablation; preserve every earlier experiment."""
import pathlib,json,hashlib,shutil
HERE=pathlib.Path(__file__).resolve().parent
BASE=HERE.parent/'sma-four-models-2026-11-14'
ROOT_CACHE=pathlib.Path('/mnt/c/Users/melli/.codex/research/centrypto')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def replace_once(text,old,new):
    assert text.count(old)==1,old
    return text.replace(old,new)
def main():
    manifest=json.loads((BASE/'delivery-manifest.json').read_text())['files']
    for name,wanted in manifest.items():assert sha(BASE/name)==wanted,name
    files=['four_common.py','detectors.py','build.py','data_four.py','network.py','engine.py','train_four.py','policy_four.py','test_four.py','inference.py','evaluate.py','validate_four.py','deliver.py']
    for name in files:shutil.copy2(BASE/name,HERE/name)
    cfg=json.loads((BASE/'config.json').read_text());cfg['experiment']=HERE.name;cfg['entry_news']=False
    cfg['comparison']='Controlled news-removal ablation of sma-four-models-2026-11-14. Identical data, labels, detector, splits, seeds, optimizer, checkpoint/threshold grids and execution rules. Retune only on the same earlier validation data.'
    cfg['deployment']='Offline only; news features excluded from every entry and exit model. Four final artifacts; no production activation.'
    (HERE/'config.json').write_text(json.dumps(cfg,indent=2))
    p=HERE/'data_four.py';s=p.read_text()
    s=replace_once(s,'self.entry_names=self.d.entry_names[:-1]+CONTEXT_NAMES','self.entry_base_names=self.d.market_names+self.d.sma_names\n        self.entry_names=self.entry_base_names+CONTEXT_NAMES\n        assert not any(n.startswith(\'news_\') for n in self.entry_names)')
    s=replace_once(s,"c=self.c[ids];raw=self.d.entry_rows(c['row']*2+(c['side']==-1))[:,:-1]","c=self.c[ids];rows=c['row'];raw=np.column_stack([self.d.market[rows],self.d.sma[rows]])")
    p.write_text(s)
    p=HERE/'train_four.py';s=p.read_text();s=replace_once(s,"'kind':'entry','side':name,'news_allowed':True","'kind':'entry','side':name,'news_allowed':False");p.write_text(s)
    p=HERE/'test_four.py';s=p.read_text();s=replace_once(s,"data=FourData();assert not any('news' in n or 'entry_score' in n for n in data.exit_names)","data=FourData();assert not any('news' in n or 'entry_score' in n for n in data.exit_names)\n    assert not any('news' in n for n in data.entry_names)");p.write_text(s)
    p=HERE/'validate_four.py';s=p.read_text()
    s=replace_once(s,"encoded=np.array([e*2+(side==-1)]);raw=data.d.entry_rows(encoded)[0,:-1];features=dict(zip(data.d.entry_names[:-1],raw))","raw=np.r_[data.d.market[e],data.d.sma[e]];features=dict(zip(data.entry_base_names,raw))")
    s=replace_once(s,"assert not any('news' in name for name in final.models[side]['exit']['input_names'])","assert not any('news' in name for kind in ['entry','exit'] for name in final.models[side][kind]['input_names'])")
    s=s.replace("'exit_has_no_news':True","'entry_and_exit_have_no_news':True")
    s=replace_once(s,"assert np.allclose(before,data.entry_rows(sample),equal_nan=True);data.c=original","assert np.allclose(before,data.entry_rows(sample),equal_nan=True);data.c=original\n    class ForbiddenNews:\n        def __getitem__(self,key):raise AssertionError('News accessed by no-news entry builder')\n    old_news=data.d.news;data.d.news=ForbiddenNews()\n    assert np.allclose(before,data.entry_rows(sample),equal_nan=True);data.d.news=old_news\n    checks['entry_builder_does_not_access_news']=1")
    p.write_text(s)
    p=HERE/'deliver.py';s=p.read_text().replace("'entry_input_raw_dimensions':349","'entry_input_raw_dimensions':188")
    s=replace_once(s,"    save('model-card.json',card)","    card['entry_news']=False\n    card['news_ablation']=json.loads((HERE/'ablation-spec.json').read_text())\n    for item in card['models'].values():assert item['news_retained_raw_features']==0\n    card['comparison_file']='news-ablation.json'\n    save('model-card.json',card)")
    p.write_text(s)
    cache=ROOT_CACHE/HERE.name;cache.mkdir(exist_ok=True)
    hashes={}
    for name in ['setups.npy','candidates.npy']:
        shutil.copy2(ROOT_CACHE/BASE.name/name,cache/name);hashes[name]=sha(cache/name)
        assert hashes[name]==sha(ROOT_CACHE/BASE.name/name)
    shutil.copy2(BASE/'dataset-profile.json',HERE/'dataset-profile.json')
    audit={'baseline':str(BASE),'baseline_verified_files':len(manifest),'baseline_manifest_sha256':sha(BASE/'delivery-manifest.json'),
       'identical_dataset_hashes':hashes,'removed_entry_columns':161,'new_raw_entry_dimensions':188,'unchanged_raw_exit_dimensions':185,
       'changed_config_keys':[k for k in cfg if cfg.get(k)!=json.loads((BASE/'config.json').read_text()).get(k)],
       'all_other_hyperparameters_unchanged':True}
    (HERE/'ablation-spec.json').write_text(json.dumps(audit,indent=2));print(json.dumps(audit))
if __name__=='__main__':main()
