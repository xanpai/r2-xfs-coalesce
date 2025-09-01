// Helper functions for download operations

export function cleanupActiveRequests(activeRequests: Map<string, Promise<Response>>): void {
    if (activeRequests.size > 100) { // Prevent memory leaks
        console.log('Cleaning up active requests map, size:', activeRequests.size)
        activeRequests.clear()
    }
}

export function processLargeFileResponse(
    response: Response,
    url: URL,
    source: 'b2' | 'r2',
    contentLength?: number
): Response {
    const originalHeaders = Object.fromEntries(response.headers.entries())
    const filename = url.pathname.split('/').pop() || 'download'
    const fileSize = contentLength || parseInt(response.headers.get('content-length') || '0')

    const newHeaders: Record<string, string> = {
        ...originalHeaders
    }

    // Ensure proper content-disposition
    if (!newHeaders['content-disposition']?.includes('filename')) {
        newHeaders['content-disposition'] = `attachment; filename="${filename}"`
    }

    const fileSizeMB = Math.round(fileSize / 1024 / 1024)
    const isSmallEnoughForWorkerCache = fileSize <= 400 * 1024 * 1024

    // Set cache strategy based on file size and source
    if (source === 'b2') {
        if (isSmallEnoughForWorkerCache) {
            // Small B2 files: Worker cache + CDN cache
            newHeaders['cache-control'] = 'public, max-age=1800, s-maxage=259200, stale-while-revalidate=86400' // 30min browser, 3 days CDN
            newHeaders['x-cache-strategy'] = 'worker+cdn-b2'
        } else {
            // Large B2 files: CDN cache only (very aggressive to reduce B2 calls)
            newHeaders['cache-control'] = 'public, max-age=300, s-maxage=2592000, stale-while-revalidate=86400' // 5min browser, 30 days CDN
            newHeaders['x-cache-strategy'] = 'cdn-aggressive-b2'
        }
    } else {
        // R2: More standard caching regardless of size
        newHeaders['cache-control'] = 'public, max-age=3600, s-maxage=604800' // 1hr browser, 7 days CDN
        newHeaders['x-cache-strategy'] = 'cdn-standard-r2'
    }

    // Essential headers for large file downloads
    newHeaders['accept-ranges'] = 'bytes'
    newHeaders['x-file-source'] = source
    newHeaders['x-file-size'] = fileSize.toString()
    newHeaders['x-worker-cacheable'] = isSmallEnoughForWorkerCache.toString()

    // Help with download managers and resumable downloads
    if (!newHeaders['etag']) {
        // Generate a simple etag based on file path and size
        newHeaders['etag'] = `"${btoa(url.pathname + fileSize).slice(0, 16)}"`
    }

    // CORS headers for browser compatibility
    newHeaders['access-control-allow-origin'] = '*'
    newHeaders['access-control-allow-methods'] = 'GET, HEAD, OPTIONS'
    newHeaders['access-control-allow-headers'] = 'Range, If-Range, If-Modified-Since'
    newHeaders['access-control-expose-headers'] = 'Content-Range, Content-Length, Accept-Ranges'

    console.log(`Serving ${source.toUpperCase()} file: ${fileSizeMB}MB (${isSmallEnoughForWorkerCache ? 'Worker+CDN' : 'CDN-only'} caching)`)

    return new Response(response.body, {
        status: response.status,
        headers: new Headers(newHeaders)
    })
}

export function extractFilenameFromUrl(url: URL): string {
    const pathname = url.pathname
    const segments = pathname.split('/')
    const filename = segments[segments.length - 1]

    // Handle cases where URL ends with /
    if (!filename || filename === '') {
        return 'download'
    }

    // Decode URL-encoded characters
    try {
        return decodeURIComponent(filename)
    } catch (error) {
        console.warn('Failed to decode filename:', filename, error)
        return filename
    }
}

export function isB2Url(url: URL): boolean {
    return url.hostname.includes('backblazeb2.com') || url.hostname.includes('b2-api.com')
}

export function isR2Url(url: URL): boolean {
    return url.hostname.includes('r2.cloudflarestorage.com') || url.hostname.includes('r2.dev')
}

export function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 Bytes'

    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

export function generateETag(url: URL, fileSize: number): string {
    const data = url.pathname + fileSize.toString()
    return `"${btoa(data).slice(0, 16)}"`
}

export function shouldCacheFile(url: URL, headers: Headers): boolean {
    // Don't cache if there's a range request (partial content)
    if (headers.get('range')) {
        return false
    }

    // Don't cache if URL has query params that look like auth tokens
    const hasAuthParams = url.search.includes('token') ||
        url.search.includes('signature') ||
        url.search.includes('expires') ||
        url.search.includes('key')

    return !hasAuthParams
}

export function createRateLimitResponse(source: string, retryAfter: number = 60): Response {
    return new Response(`Rate limited by ${source}. Please try again later.`, {
        status: 429,
        headers: {
            'Retry-After': retryAfter.toString(),
            'X-Rate-Limit-Source': source,
            'Content-Type': 'text/plain'
        }
    })
}

export function addCacheHeaders(response: Response, status: string, additionalInfo?: Record<string, string>): Response {
    const headers = new Headers(response.headers)
    headers.set('x-cache-status', status)

    if (additionalInfo) {
        Object.entries(additionalInfo).forEach(([key, value]) => {
            headers.set(key, value)
        })
    }

    return new Response(response.body, {
        status: response.status,
        headers
    })
}

export interface RequestMetrics {
    startTime: number
    source: 'b2' | 'r2'
    cached: boolean
    fileSize: number
    userAgent?: string
}

export function createRequestMetrics(source: 'b2' | 'r2', userAgent?: string): RequestMetrics {
    return {
        startTime: Date.now(),
        source,
        cached: false,
        fileSize: 0,
        userAgent
    }
}

export function logRequestMetrics(metrics: RequestMetrics, url: URL): void {
    const duration = Date.now() - metrics.startTime
    const fileSizeFormatted = formatFileSize(metrics.fileSize)

    console.log(
        `Request completed: ${url.pathname} | ` +
        `Source: ${metrics.source.toUpperCase()} | ` +
        `Size: ${fileSizeFormatted} | ` +
        `Cached: ${metrics.cached} | ` +
        `Duration: ${duration}ms`
    )
}
