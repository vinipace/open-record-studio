// Shared by the inspector, project validation, preview, export, and MCP.
export const defaultAudioModel = "deepfilternet3";

export const audioModels = [
  {
    id: "rnnoise",
    name: "RNNoise",
    description: "Lightweight noise reduction. Included with the app.",
  },
  {
    id: "deepfilternet3",
    name: "DeepFilterNet3",
    description:
      "Full-band speech cleanup. Downloads once, then works offline.",
  },
  {
    id: "mossformer2",
    name: "MossFormer2",
    description:
      "Full-band speech cleanup with more processing time. Downloads once, then works offline.",
  },
];

export function audioModel(id = defaultAudioModel) {
  const model = audioModels.find((model) => model.id === id);
  if (!model) throw new Error("Invalid audio enhancement model");
  return model;
}
