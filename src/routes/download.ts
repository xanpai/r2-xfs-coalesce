import { IRequest, status, json } from 'itty-router'
import { generateSignature, decrypt, handleLargeFile, handleSmallFile } from '../utils'

export const download = async ({ headers, cf, urlHASH, query }: IRequest, env: Env, ctx: ExecutionContext) => {
    // Signature validation (same as before)
    const signature = query?.sig
    if (!signature || typeof signature !== 'string') {
        return status(400)
    }

    const userIP = headers.get('CF-Connecting-IP') ||
        headers.get('x-forwarded-for')?.split(',')[0] ||
        headers.get('x-real-ip') ||
        headers.get('remote-addr') ||
        '77.96.243.165'

    if (!userIP) {
        return status(400)
    }

    const localSignature = await generateSignature(userIP, env.SECRET)
    if (signature !== localSignature) {
        return status(405)
    }

    try {
        // Decrypt the URL
        const decodedURL = await decrypt(urlHASH.replace(/-/g, '+').replace(/_/g, '/'), env.SECRET, env.IV_SECRET)
        const url = new URL(decodedURL)

        // Check if this is a large file by doing a HEAD request first
        const headResponse = await fetch(url.toString(), {
            method: 'HEAD',
            headers: {
                'User-Agent': headers.get('User-Agent') || ''
            }
        })

        if (!headResponse.ok) {
            return status(headResponse.status >= 400 && headResponse.status < 500 ? headResponse.status : 502)
        }

        const contentLength = parseInt(headResponse.headers.get('content-length') || '0')
        const isLargeFile = contentLength > 100 * 1024 * 1024 // 100MB threshold

        if (isLargeFile) {
            // For large files, use streaming approach
            return handleLargeFile(url, headers, env)
        } else {
            // For small files, use existing cache logic
            return handleSmallFile(url, headers, ctx, env)
        }

    } catch (error) {
        console.error('Download error:', error)
        return status(503)
    }
}
