import { IRequest, status } from 'itty-router'
import { generateSignature, decrypt } from '../utils'

export const download = async ({ headers, cf, urlHASH, query }: IRequest, env: Env) => {
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

        // fetch the file from the URL b
        const response = await fetch(url.toString(), {
            method: 'GET',
            headers
        })

        if (!response.ok) {
            return status(500)
        }

        const contentDisposition = response.headers.get('content-disposition')
        const headersObject = Object.fromEntries(response.headers.entries())

        if (!contentDisposition?.includes('filename')) {
            const filename = url.pathname.split('/').pop()
            headersObject['content-disposition'] = `attachment; filename="${filename}"`
        }

        return new Response(response.body, {
            status: response.status,
            headers: new Headers(headersObject)
        })
    } catch (error) {
        console.error(error)
        return status(503)
    }
}
