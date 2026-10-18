export type AudioModelId = "rnnoise" | "deepfilternet3" | "mossformer2";
export const defaultAudioModel: AudioModelId;
export const audioModels: {
  id: AudioModelId;
  name: string;
  description: string;
}[];
export function audioModel(id?: AudioModelId): (typeof audioModels)[number];
