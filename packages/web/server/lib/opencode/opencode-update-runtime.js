// Pure historical version identity normalization for offline QA evidence.
// Runtime installation and updates belong to the DevRyan bundle owner.
export const openCodeBaseVersion = value => value?.match(/^(\d+\.\d+\.\d+)-devryan\.\d+$/)?.[1] ?? value;
