/** A failure of the build step whose message is safe to show as the deployment's failure reason. */
export class BuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BuildError'
  }
}
