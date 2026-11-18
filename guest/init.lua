-- SPDX-License-Identifier: MIT
-- Copyright (C) 2026 kvoon3
vim.opt.termguicolors = true
vim.opt.number = true
vim.opt.relativenumber = true
vim.opt.signcolumn = 'yes'
vim.opt.scrolloff = 4

vim.opt.runtimepath:prepend(vim.fn.expand '~/demos/x18n/x18n.nvim')
vim.filetype.add { extension = { vue = 'vue' } }
vim.api.nvim_create_autocmd('BufReadPost', {
  pattern = '*.vue',
  callback = function()
    vim.bo.filetype = 'vue'
  end,
})
vim.api.nvim_create_autocmd('LspAttach', {
  callback = function(ev)
    local client = vim.lsp.get_client_by_id(ev.data.client_id)
    vim.notify('x18n LSP attached: ' .. (client and client.name or 'unknown'))
  end,
})
require('x18n').setup { lsp = { cmd = { '/usr/local/bin/x18n-lsp', '--stdio' } } }

vim.g.netrw_banner = 0
vim.g.netrw_liststyle = 3
vim.cmd('edit ' .. vim.fn.fnameescape(vim.fn.expand '~/demos/x18n/playground/vue-vite/src/App.vue'))
vim.cmd('edit ' .. vim.fn.fnameescape(vim.fn.expand '~/demos/x18n/playground'))
