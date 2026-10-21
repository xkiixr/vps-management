import { privateHostname } from './names'

export function systemEnv(i: {
  port: number
  serviceName: string
  projectName: string
  publicHostname?: string
}): Record<string, string> {
  const env: Record<string, string> = {
    PORT: String(i.port),
    APP_SERVICE_NAME: i.serviceName,
    APP_PROJECT_NAME: i.projectName,
    APP_PRIVATE_DOMAIN: privateHostname(i.serviceName),
  }
  if (i.publicHostname !== undefined) env.APP_PUBLIC_DOMAIN = i.publicHostname
  return env
}
