import path from 'path'
import Chalk from 'chalk'
import consola from 'consola'
import fsExtra from 'fs-extra'
import htmlMinifier from 'html-minifier'

import { flatRoutes, isString, isUrl, promisifyRoute, waitFor } from '@nuxt/utils'

export default class Generator {
  constructor(nuxt, builder) {
    this.nuxt = nuxt
    this.options = nuxt.options
    this.builder = builder

    // Set variables
    this.staticRoutes = path.resolve(this.options.srcDir, this.options.dir.static)
    this.srcBuiltPath = path.resolve(this.options.buildDir, 'dist', 'client')
    this.distPath = this.options.generate.dir
    this.distNuxtPath = path.join(
      this.distPath,
      isUrl(this.options.build.publicPath) ? '' : this.options.build.publicPath
    )
  }

  async generate({ build = true, init = true } = {}) {
    consola.debug('Initializing generator...')

    await this.initiate({ build, init })

    consola.debug('Preparing routes for generate...')

    const routes = await this.initRoutes()

    consola.info('Generating pages')

    const errors = await this.generateRoutes(routes)

    await this.afterGenerate()

    // Done hook
    await this.nuxt.callHook('generate:done', this, errors)

    return { errors }
  }

  async initiate({ build = true, init = true } = {}) {
    // Wait for nuxt be ready
    await this.nuxt.ready()

    // Call before hook
    await this.nuxt.callHook('generate:before', this, this.options.generate)

    if (build) {
      // Add flag to set process.static
      this.builder.forGenerate()

      // Start build process
      await this.builder.build()
    }

    // Initialize dist directory
    if (init) {
      await this.initDist()
    }
  }

  async initRoutes(...args) {
    // Resolve config.generate.routes promises before generating the routes
    let generateRoutes = []
    if (this.options.router.mode !== 'hash') {
      try {
        generateRoutes = await promisifyRoute(
          this.options.generate.routes || [],
          ...args
        )
      } catch (e) {
        consola.error('Could not resolve routes')
        throw e // eslint-disable-line no-unreachable
      }
    }
    // Generate only index.html for router.mode = 'hash'
    let routes =
      this.options.router.mode === 'hash'
        ? ['/']
        : flatRoutes(this.options.router.routes)

    routes = routes.filter(route => this.options.generate.exclude.every(regex => !regex.test(route)))

    routes = this.decorateWithPayloads(routes, generateRoutes)

    // extendRoutes hook
    await this.nuxt.callHook('generate:extendRoutes', routes)

    return routes
  }

  async generateRoutes(routes) {
    const errors = []

    // Start generate process
    while (routes.length) {
      let n = 0
      await Promise.all(
        routes
          .splice(0, this.options.generate.concurrency)
          .map(async ({ route, payload }) => {
            await waitFor(n++ * this.options.generate.interval)
            await this.generateRoute({ route, payload, errors })
          })
      )
    }

    // Improve string representation for errors
    // TODO: Use consola for more consistency
    errors.toString = () => this._formatErrors(errors)

    return errors
  }

  _formatErrors(errors) {
    return errors
      .map(({ type, route, error }) => {
        const isHandled = type === 'handled'
        const color = isHandled ? 'yellow' : 'red'

        let line = Chalk[color](` ${route}\n\n`)

        if (isHandled) {
          line += Chalk.grey(JSON.stringify(error, undefined, 2) + '\n')
        } else {
          line += Chalk.grey(error.stack)
        }

        return line
      })
      .join('\n')
  }

  async afterGenerate() {
    const { fallback } = this.options.generate

    // Disable SPA fallback if value isn't a non-empty string
    if (typeof fallback !== 'string' || !fallback) {
      return
    }

    const fallbackPath = path.join(this.distPath, fallback)

    // Prevent conflicts
    if (await fsExtra.exists(fallbackPath)) {
      consola.warn(`SPA fallback was configured, but the configured path (${fallbackPath}) already exists.`)
      return
    }

    // Render and write the SPA template to the fallback path
    const { html } = await this.nuxt.server.renderRoute('/', { spa: true })
    await fsExtra.writeFile(fallbackPath, html, 'utf8')
  }

  async initDist() {
    // Clean destination folder
    await fsExtra.remove(this.distPath)

    await this.nuxt.callHook('generate:distRemoved', this)

    // Copy static and built files
    if (await fsExtra.exists(this.staticRoutes)) {
      await fsExtra.copy(this.staticRoutes, this.distPath)
    }
    await fsExtra.copy(this.srcBuiltPath, this.distNuxtPath)

    // Add .nojekyll file to let GitHub Pages add the _nuxt/ folder
    // https://help.github.com/articles/files-that-start-with-an-underscore-are-missing/
    const nojekyllPath = path.resolve(this.distPath, '.nojekyll')
    fsExtra.writeFile(nojekyllPath, '')

    await this.nuxt.callHook('generate:distCopied', this)
  }

  decorateWithPayloads(routes, generateRoutes) {
    const routeMap = {}
    // Fill routeMap for known routes
    routes.forEach((route) => {
      routeMap[route] = { route, payload: null }
    })
    // Fill routeMap with given generate.routes
    generateRoutes.forEach((route) => {
      // route is either a string or like { route : '/my_route/1', payload: {} }
      const path = isString(route) ? route : route.route
      routeMap[path] = {
        route: path,
        payload: route.payload || null
      }
    })
    return Object.values(routeMap)
  }

  async generateRoute({ route, payload = {}, errors = [] }) {
    let html
    const pageErrors = []

    try {
      const res = await this.nuxt.server.renderRoute(route, {
        _generate: true,
        payload
      })
      ;({ html } = res)
      if (res.error) {
        pageErrors.push({ type: 'handled', route, error: res.error })
      }
    } catch (err) {
      pageErrors.push({ type: 'unhandled', route, error: err })
      errors.push(...pageErrors)

      await this.nuxt.callHook('generate:routeFailed', {
        route,
        errors: pageErrors
      })
      consola.error(this._formatErrors(pageErrors))

      return false
    }

    let minificationOptions = this.options.build.html.minify

    // Legacy: Override minification options with generate.minify if present
    // TODO: Remove in Nuxt version 3
    if (typeof this.options.generate.minify !== 'undefined') {
      minificationOptions = this.options.generate.minify
      consola.warn('generate.minify has been deprecated and will be removed in the next major version.' +
        ' Use build.html.minify instead!')
    }

    if (minificationOptions) {
      try {
        html = htmlMinifier.minify(html, minificationOptions)
      } catch (err) {
        const minifyErr = new Error(
          `HTML minification failed. Make sure the route generates valid HTML. Failed HTML:\n ${html}`
        )
        pageErrors.push({ type: 'unhandled', route, error: minifyErr })
      }
    }

    let _path

    if (this.options.generate.subFolders) {
      _path = path.join(route, path.sep, 'index.html') // /about -> /about/index.html
      _path = _path === '/404/index.html' ? '/404.html' : _path // /404 -> /404.html
    } else {
      _path = route.length > 1 ? path.join(path.sep, route + '.html') : path.join(path.sep, 'index.html')
    }

    // Call hook to let user update the path & html
    const page = { route, path: _path, html }
    await this.nuxt.callHook('generate:page', page)

    page.path = path.join(this.distPath, page.path)

    // Make sure the sub folders are created
    await fsExtra.mkdirp(path.dirname(page.path))
    await fsExtra.writeFile(page.path, page.html, 'utf8')

    await this.nuxt.callHook('generate:routeCreated', {
      route,
      path: page.path,
      errors: pageErrors
    })

    if (pageErrors.length) {
      consola.error('Error generating ' + route)
      errors.push(...pageErrors)
    } else {
      consola.success('Generated ' + route)
    }

    return true
  }
}
