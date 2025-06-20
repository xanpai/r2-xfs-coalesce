import { IRequest, status } from 'itty-router'
import { decrypt, generateSignature } from '../utils'

export const upload = async (request: IRequest, env: Env) => {
    const { headers, cf, urlHASH, query } = request

    // get signature from query and check if it exists
    const signature = query?.sig
    if (!signature) {
        return status(400)
    }

    // make sure signature is a string
    if (typeof signature !== 'string') {
        return status(404)
    }

    // get user IP address
    const userIP = headers.get('CF-Connecting-IP') ||
        headers.get('x-forwarded-for')?.split(',')[0] ||
        headers.get('x-real-ip') ||
        headers.get('remote-addr') ||
        '127.0.0.1'

    // generate local signature and compare with the one from the query
    const localSignature = await generateSignature(userIP, env.SECRET)
    if (signature !== localSignature) {
        return status(405)
    }

    try {
        // decrypt the URL
        const decodedURL = await decrypt(urlHASH.replace(/-/g, '+').replace(/_/g, '/'), env.SECRET, env.IV_SECRET)
        const url = new URL(decodedURL)

        // get the request body (file data)
        const fileData = await request.arrayBuffer()
        if (!fileData || fileData.byteLength === 0) {
            return status(400)
        }

        // prepare headers for the proxied request
        const proxyHeaders = new Headers()

        // copy all headers from the original request (except some that shouldn't be proxied)
        const skipHeaders = ['host', 'connection', 'cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-real-ip']

        for (const [key, value] of headers.entries()) {
            if (!skipHeaders.includes(key.toLowerCase())) {
                proxyHeaders.set(key, value)
            }
        }

        // ensure content-length is set correctly
        proxyHeaders.set('Content-Length', fileData.byteLength.toString())

        // make the proxied upload request
        return await fetch(url.toString(), {
            method: 'PUT',
            headers: proxyHeaders,
            body: fileData,
            // add timeout to prevent hanging requests
            signal: AbortSignal.timeout(300000) // 5 minutes
        })
    } catch (error) {
        return status(503)
    }
}
