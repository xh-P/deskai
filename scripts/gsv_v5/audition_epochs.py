"""Render the requested 3 x 3 checkpoint listening comparison."""
from __future__ import annotations

import argparse
import copy
import hashlib
import html
import json
import subprocess
from pathlib import Path

from common import ENV, PROJECT, ROOT, activate, write_json
from audition import make_job, synthesize


def main():
    activate()
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--worker')
    args = parser.parse_args()
    output = args.output_dir.resolve()
    if args.worker:
        job = json.loads((output / 'comparison.json').read_text(encoding='utf-8'))
        synthesize(args.worker, output, job)
        return
    if output.exists():
        raise FileExistsError('Use a fresh output directory to preserve previous samples.')
    # Validate all requested exports before creating a comparison.
    pairs = []
    for s2 in (4, 6, 8):
        for gpt in (5, 10, 15):
            matches = list((PROJECT / 'weights/sovits').glob(f'*_e{s2}_s*_l16.pth'))
            if len(matches) != 1:
                raise RuntimeError(f'Expected one SoVITS epoch {s2} export: {matches}')
            gp = PROJECT / f'weights/gpt/nagato_disappearance_v5turbo-e{gpt}.ckpt'
            if not gp.is_file():
                raise FileNotFoundError(gp)
            pairs.append((s2, gpt, matches[0], gp))
    output.mkdir(parents=True)
    job = make_job(argparse.Namespace(reference=3, text=None, language='zh'), output)
    base = copy.deepcopy(job['models']['v5_base'])
    job['models'] = {}
    job['trained_checkpoints'] = {}
    job.pop('training_performed', None)
    job['training_performed_by_this_script'] = False
    original, _, _, text = (PROJECT / 'holdout.list').read_text(encoding='utf-8').splitlines()[0].split('|', 3)
    job['texts'] = copy.deepcopy(job['texts']) + [dict(id='ja_holdout', language='all_ja', text=text)]
    job['holdout_original'] = original
    for s2, gpt, sp, gp in pairs:
        name = f'v5_s2e{s2}_gpte{gpt}'
        cfg = copy.deepcopy(base)
        cfg.update(vits_weights_path=str(sp), t2s_weights_path=str(gp))
        job['models'][name] = cfg
        job['trained_checkpoints'][name] = dict(sovits_epoch=s2, gpt_epoch=gpt,
            hashes={str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in (sp, gp)})
    job['comparison_note'] = 'All nine combinations; identical reference, text, seed and inference settings. No training by this script.'
    write_json(output / 'comparison.json', job)
    for name in job['models']:
        print(f'Generating {name}', flush=True)
        with (output / f'{name}.log').open('w', encoding='utf-8') as log:
            subprocess.run([str(ENV / 'python.exe'), '-u', str(Path(__file__).resolve()),
                '--output-dir', str(output), '--worker', name], cwd=ROOT,
                stdout=log, stderr=subprocess.STDOUT, check=True)
    parts = ['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>长门 v5 各轮试听</title>',
        '<style>body{font:16px system-ui;max-width:1100px;margin:32px auto;padding:16px;background:#fafafa;color:#222}section{margin:24px 0;padding:20px;background:white;border:1px solid #ddd}article{display:inline-block;vertical-align:top;width:32%;min-width:300px}audio{max-width:95%}p{line-height:1.6}</style>',
        '<h1>长门 v5 各轮试听</h1><p>SoVITS 第 4、6、8 轮 × GPT 第 5、10、15 轮，共 9 种组合、27 段音频。全部使用同一参考音频、文本和随机种子。</p>',
        '<p>先固定 GPT 第 10 轮比较 SoVITS，再固定喜欢的 SoVITS 比较 GPT；也可以直接比较全部组合。留出台词未参与训练。请留意音色、漏字、重复、语气与句尾。</p>',
        '<p>参考音频</p><audio controls preload="none" src="reference.wav"></audio>']
    for s2, gpt, _, _ in pairs:
        name = f'v5_s2e{s2}_gpte{gpt}'
        parts.append(f'<section><h2>SoVITS {s2} 轮 · GPT {gpt} 轮</h2>')
        for item in job['texts']:
            label = {'zh':'中文新台词', 'ja':'日文新台词', 'ja_holdout':'日文留出台词'}[item['id']]
            parts.append(f'<article><h3>{label}</h3><p>{html.escape(item["text"])}</p><audio controls preload="none" src="{item["id"]}_{name}.wav"></audio></article>')
        parts.append('</section>')
    parts.append('<script>document.addEventListener("play",function(e){if(e.target.tagName==="AUDIO")document.querySelectorAll("audio").forEach(function(a){if(a!==e.target)a.pause()})},true)</script></html>')
    (output / '试听.html').write_text('\n'.join(parts), encoding='utf-8')
    write_json(output / 'completed.json', dict(combinations=9, samples=27, success=True))
    print(f'Completed: {output / "试听.html"}', flush=True)


if __name__ == '__main__':
    main()
