export const INPUT_RATE = 16000;
export const VAD_FRAME_SAMPLES = 512;

export type InterruptionConfig = {
  startDelayMs: number;
  confirmMs: number;
  minVoicedMs: number;
  preRollMs: number;
  referenceLookbackMs: number;
  minReferenceRms: number;
  minRms: number;
  rawMinRmsMultiplier: number;
  vadThreshold: number;
  echo: {
    waveformCorrelation: number;
    rawCorrelation: number;
    residualCorrelation: number;
    residualRatio: number;
    strongRawCorrelation: number;
    strongRawResidualCorrelation: number;
    singleSignalCorrelation: number;
  };
};

export type EndpointConfig = { candidateWindowMs: number; continuationWindowMs: number; unfinishedWindowMs: number; vadThreshold: number };
