export function portableWebArguments(args: string[]): string[]
export function portableEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv
export function runPortable(args: string[], environment?: NodeJS.ProcessEnv): Promise<number>
