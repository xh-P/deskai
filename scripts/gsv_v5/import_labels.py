"""Import the two user-selected annotation sets without changing source assets."""
from __future__ import annotations

import json
from pathlib import Path

from common import PROJECT, ROOT, SOURCE, EXPERIMENT, activate, write_json
from manage import audit, sha


def main():
    activate()
    if (PROJECT / 'checkpoints/dataset.sha256').exists():
        raise RuntimeError('An existing training run is locked; use a new experiment to replace its inputs.')
    sources = [
        ROOT / 'assets/Nagato_labels_and_review/Nagato_Disappearance_annotations/lexical_consensus_candidate.list',
        ROOT / 'assets/Nagato_short_no_asr_warnings/short_machine_draft.list',
    ]
    rows, seen, provenance = [], set(), []
    for source in sources:
        count = 0
        for number, line in enumerate(source.read_text(encoding='utf-8-sig').splitlines(), 1):
            if not line.strip():
                continue
            relative, speaker, language, text = line.split('|', 3)
            name = Path(relative.replace('\\', '/')).name
            original = SOURCE / name
            if name in seen or not original.is_file():
                raise ValueError(f'Duplicate or unknown audio: {source}:{number}: {name}')
            if language.lower() not in {'ja', 'jp'} or not text.strip() or '|' in text:
                raise ValueError(f'Invalid annotation: {source}:{number}')
            packaged = source.parent / relative
            if packaged.exists() and sha(packaged) != sha(original):
                raise ValueError(f'Packaged audio differs from original: {name}')
            seen.add(name)
            rows.append(dict(file=name, source=str(original), source_sha256=sha(original),
                             annotation_source=str(source), annotation_line=number, text=text))
            count += 1
        provenance.append(dict(path=str(source), sha256=sha(source), count=count))
    inputs = PROJECT / 'inputs'
    inputs.mkdir(exist_ok=True)
    for source in sources:
        (inputs / source.name).write_bytes(source.read_bytes())
    rows.sort(key=lambda row: row['file'])
    labels = ''.join(f"{Path(row['source']).as_posix()}|{EXPERIMENT}|JA|{row['text']}\n" for row in rows)
    (PROJECT / 'labels.list').write_text(labels, encoding='utf-8')
    audit()
    manifest_path = PROJECT / 'dataset_manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    manifest['labels_status'] = 'user_selected_machine_annotations_imported'
    write_json(manifest_path, manifest)
    write_json(inputs / 'provenance.json', dict(sources=provenance, count=len(rows), rows=rows,
        note='User-selected union. Original annotation text and original WAV files are unchanged.'))
    print(f'Imported {len(rows)} unique Japanese annotations; training has not started.')


if __name__ == '__main__':
    main()
