import { IRequest, status, json } from 'itty-router'
import { generateSignature, decrypt } from '../utils'

export const download = async ({ headers, cf, urlHASH, query }: IRequest, env: Env) => {
    // // get signature from query and check if it exists
    // const signature = query?.sig
    // if (!signature) {
    //     return status(400)
    // }
    //
    // // make sure signature is a string
    // if (typeof signature !== 'string') {
    //     return status(404)
    // }
    //
    // get user IP address
    const userIP = headers.get('CF-Connecting-IP') ||
        headers.get('x-forwarded-for')?.split(',')[0] ||
        headers.get('x-real-ip') ||
        headers.get('remote-addr') ||
        '127.0.0.1'
    //
    // // generate a local signature and compare with the one from the query
    // const localSignature = await generateSignature(userIP, env.SECRET)
    // if (signature !== localSignature) {
    //     return status(405)
    // }

    try {
        // decrypt the URL
        const decodedURL = await decrypt(urlHASH.replace(/-/g, '+').replace(/_/g, '/'), env.SECRET, env.IV_SECRET)
        const url = new URL(decodedURL)

        // Retry logic with proper variable scope
        let response: Response | null = null
        const maxRetries = 2

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 25000) // 25s timeout

            try {
                response = await fetch(url.toString(), {
                    method: 'GET',
                    // @ts-ignore
                    headers: {
                        // Forward only safe headers to R2
                        ...(headers.get('range') && { 'range': headers.get('range') }),
                        ...(headers.get('if-none-match') && { 'if-none-match': headers.get('if-none-match') })
                    },
                    signal: controller.signal
                })

                // if dev sent some data
                if (query.__debug === 'true') {
                    return json({
                        response: {
                            status: response.status,
                            headers: Object.fromEntries(response.headers.entries()),
                            statusText: response.statusText
                        },
                        userIP,
                        url,
                        signature: {
                            server: query.sig,
                            local: await generateSignature(userIP, env.SECRET)
                        }
                    })
                }

                clearTimeout(timeoutId)

                // Handle successful responses
                if (response.ok) {
                    break // Success! Exit retry loop
                }

                // Handle specific error codes
                if (response.status === 404) {
                    return new Response('File not found', { status: 404 })
                }

                if (response.status === 403) {
                    return new Response('Access denied', { status: 403 })
                }

                // For 500 errors, log details and potentially retry
                if (response.status >= 500) {

                    // Don't retry on last attempt
                    if (attempt === maxRetries) {
                        return new Response(`Server error: ${response.status}`, { status: 502 })
                    }

                    // Continue to retry logic below
                } else {
                    // Other 4xx errors shouldn't be retried
                    return new Response(`Client error: ${response.status}`, { status: response.status })
                }

            } catch (fetchError) {
                clearTimeout(timeoutId)
                const error = fetchError as Error
                console.error(`Fetch attempt ${attempt + 1} failed:`, error.message)

                // On last attempt, return error
                if (attempt === maxRetries) {
                    if (error?.name === 'AbortError') {
                        return new Response('Request timeout', { status: 504 })
                    }
                    return new Response('Network error', { status: 502 })
                }

                // Continue to retry logic below for network errors
            }

            // Exponential backoff before retry (only reached if we're retrying)
            if (attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * 1000 // 1s, 2s, 4s...
                await new Promise(resolve => setTimeout(resolve, delay))
            }
        }

        // Check if we have a successful response
        if (!response || !response.ok) {
            return new Response('Failed to fetch file after all retries', { status: 502 })
        }

        // Process the successful response
        const contentDisposition = response.headers.get('content-disposition')
        const headersObject = Object.fromEntries(response.headers.entries())

        if (!contentDisposition?.includes('filename')) {
            const filename = url.pathname.split('/').pop() || 'download'
            const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_')
            headersObject['content-disposition'] = `attachment; filename="${sanitizedFilename}"`
        }

        return new Response(response.body, {
            status: response.status,
            headers: new Headers(headersObject)
        })

    } catch (error) {
        return new Response('Service unavailable', { status: 503 })
    }
}
