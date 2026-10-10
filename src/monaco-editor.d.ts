declare module "*?worker" {
  const EditorWorker: { new(): Worker };
  export default EditorWorker;
}