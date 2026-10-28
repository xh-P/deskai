"""Compare trained v5 checkpoints with the base v5 and the supplied v2 voice."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from common import ENV, PROJECT, ROOT, activate, write_json
from audition import make_job, synthesize


def main():
    activate()
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--worker', choices=['v2_tuned', 'v5_base', 'v5_s2e1_gpte10', 'v5_s2e2_gpte10', 'v5_s2e2_gpte5'])
    args = parser.parse_args()
    stamp = datetime.now(timezone(timedelta(hours=8))).strftime('%Y%m%d-%H%M%S-trained')
    output = (args.output_dir or ROOT / 'outputs/nagato_audition' / stamp).resolve()
    if args.worker:
        job = json.loads((output / 'comparison.json').read_text(encoding='utf-8'))
        synthesize(args.worker, output, job)
        return
    output.mkdir(parents=True, exist_ok=True)
    if (output / 'comparison.json').exists():
        raise FileExistsError('Choose a fresh output directory to preserve the previous comparison.')
    job = make_job(argparse.Namespace(reference=3, text=None, language='zh'), output)
    job.pop('training_performed', None)
    job['training_performed_by_this_script'] = False
    job['trained_checkpoints'] = {}
    for name, s2_epoch, gpt_epoch in [('v5_s2e1_gpte10',1,10), ('v5_s2e2_gpte10',2,10), ('v5_s2e2_gpte5',2,5)]:
        config = copy.deepcopy(job['models']['v5_base'])
        config['t2s_weights_path'] = str(PROJECT / f'weights/gpt/nagato_disappearance_v5turbo-e{gpt_epoch}.ckpt')
        config['vits_weights_path'] = str(PROJECT / f'weights/sovits/nagato_disappearance_v5turbo_e{s2_epoch}_s{s2_epoch*320}_l16.pth')
        for key in ('t2s_weights_path','vits_weights_path'):
            if not Path(config[key]).is_file():
                raise FileNotFoundError(config[key])
        job['models'][name] = config
        job['trained_checkpoints'][name] = dict(sovits_epoch=s2_epoch, gpt_epoch=gpt_epoch,
            hashes={key:hashlib.sha256(Path(config[key]).read_bytes()).hexdigest()
                    for key in ('t2s_weights_path','vits_weights_path')})
    holdout_line = (PROJECT / 'holdout.list').read_text(encoding='utf-8').splitlines()[0]
    original, _, _, text = holdout_line.split('|',3)
    job['texts'].append(dict(id='ja_holdout',language='all_ja',text=text))
    job['holdout_original'] = original
    job['comparison_note'] = 'Same reference, text, seed and inference path. No optimization is performed by this script. Includes non-training dialogue and one held-out transcript.'
    write_json(output / 'comparison.json', job)
    for name in ['v5_s2e2_gpte10', 'v5_s2e1_gpte10', 'v5_s2e2_gpte5', 'v5_base', 'v2_tuned']:
        print(f'Generating {name}: {output}', flush=True)
        with (output / f'{name}.log').open('w',encoding='utf-8') as log:
            subprocess.run([str(ENV/'python.exe'),'-u',str(Path(__file__).resolve()),'--worker',name,
                            '--output-dir',str(output)],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True)
    print(f'Completed 15 audition samples: {output}', flush=True)


if __name__ == '__main__':
    main()
