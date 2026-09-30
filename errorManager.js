// ============================================================
// errorManager.js – Gestion centralisée des erreurs professionnelles
// Version 1.0 – Intégré à CP Engineer Pro
// P2-26 : Toast comme fallback au lieu de alert
// ============================================================

const ErrorManager = (function() {
    'use strict';

    // --- État interne ---
    let queue = [];
    let isShowing = false;
    let modalElement = null;
    let fallbackUsed = false;

    // --- Configuration ---
    const CONFIG = {
        maxQueueSize: 10,
        fallbackDelay: 500,
        defaultCode: 'ERR-0000'
    };

    // --- Initialisation du DOM du modal ---
    function createModal() {
        if (modalElement) return modalElement;

        const modal = document.createElement('div');
        modal.id = 'errorModal';
        modal.className = 'modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'errorModalTitle');
        modal.style.display = 'none';

        modal.innerHTML = `
            <div class="modal-content error-modal-content" style="max-width: 550px;">
                <div class="error-modal-header">
                    <div class="error-type-icon" id="errorModalIcon">⚠️</div>
                    <h3 id="errorModalTitle" style="margin: 0;">Erreur</h3>
                </div>
                <div class="error-modal-body">
                    <p id="errorModalMessage" style="font-size: 1rem; margin: 0.5rem 0;"></p>
                    <div id="errorModalDetails" style="margin-top: 0.5rem; padding: 0.5rem; background: var(--bg-tertiary); border-radius: var(--radius-sm); font-size: 0.85rem; color: var(--text-secondary); display: none;"></div>
                    <div id="errorModalCode" style="margin-top: 0.3rem; font-size: 0.75rem; color: var(--text-muted); text-align: right;"></div>
                </div>
                <div class="error-modal-footer" style="display: flex; justify-content: flex-end; margin-top: 1rem;">
                    <button id="errorModalOkBtn" class="btn btn-primary" style="min-width: 80px;">OK</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Gestion du bouton OK
        const okBtn = modal.querySelector('#errorModalOkBtn');
        okBtn.addEventListener('click', function() {
            hide();
        });

        // Fermeture avec Escape (sauf pour les erreurs critiques)
        modal.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                hide();
            }
        });

        modalElement = modal;
        return modal;
    }

    // --- Affichage du modal avec les données ---
    function renderModal(options) {
        const modal = createModal();
        const icon = modal.querySelector('#errorModalIcon');
        const title = modal.querySelector('#errorModalTitle');
        const message = modal.querySelector('#errorModalMessage');
        const details = modal.querySelector('#errorModalDetails');
        const codeEl = modal.querySelector('#errorModalCode');
        const okBtn = modal.querySelector('#errorModalOkBtn');

        // Type et icône
        let typeIcon = '⚠️';
        let typeLabel = 'Erreur';
        if (options.type === 'warning') { typeIcon = '⚠️'; typeLabel = 'Avertissement'; }
        else if (options.type === 'info') { typeIcon = 'ℹ️'; typeLabel = 'Information'; }
        else if (options.type === 'success') { typeIcon = '✅'; typeLabel = 'Succès'; }
        else { typeIcon = '❌'; typeLabel = 'Erreur'; }

        icon.textContent = typeIcon;
        title.textContent = options.title || typeLabel;

        // Message principal
        message.textContent = options.message || 'Une erreur inattendue est survenue.';

        // Détails techniques (si fournis)
        let detailsHtml = '';
        if (options.details) {
            detailsHtml += `<div style="display:grid; grid-template-columns:auto 1fr; gap:0.2rem 0.5rem; margin-top:0.3rem;">`;
            if (options.details.module) detailsHtml += `<span style="font-weight:500;">Module</span><span>${Utils.escapeHtml(options.details.module)}</span>`;
            if (options.details.function) detailsHtml += `<span style="font-weight:500;">Fonction</span><span>${Utils.escapeHtml(options.details.function)}</span>`;
            if (options.details.parameter) detailsHtml += `<span style="font-weight:500;">Paramètre</span><span>${Utils.escapeHtml(options.details.parameter)}</span>`;
            if (options.details.value !== undefined) detailsHtml += `<span style="font-weight:500;">Valeur reçue</span><span>${Utils.escapeHtml(String(options.details.value))}</span>`;
            if (options.details.expected !== undefined) detailsHtml += `<span style="font-weight:500;">Valeur attendue</span><span>${Utils.escapeHtml(String(options.details.expected))}</span>`;
            if (options.details.technical) detailsHtml += `<span style="font-weight:500;">Détail technique</span><span style="font-family:monospace; font-size:0.75rem;">${Utils.escapeHtml(options.details.technical)}</span>`;
            detailsHtml += `</div>`;
        }
        if (detailsHtml) {
            details.innerHTML = detailsHtml;
            details.style.display = 'block';
        } else {
            details.style.display = 'none';
        }

        // Code d'erreur
        const code = options.code || CONFIG.defaultCode;
        codeEl.textContent = code !== CONFIG.defaultCode ? `Code : ${code}` : '';

        // Focus sur le bouton OK
        setTimeout(() => okBtn.focus(), 50);

        // Afficher le modal
        modal.style.display = 'flex';
        isShowing = true;
    }

    // --- Cacher le modal et traiter la file d'attente ---
    function hide() {
        if (modalElement) {
            modalElement.style.display = 'none';
        }
        isShowing = false;
        // Traiter la file d'attente
        processQueue();
    }

    // --- File d'attente ---
    function enqueue(options) {
        if (queue.length >= CONFIG.maxQueueSize) {
            // Supprimer les plus anciens
            queue.shift();
        }
        // Éviter les doublons exacts (même message et code)
        const duplicate = queue.some(item =>
            item.message === options.message &&
            item.code === options.code
        );
        if (!duplicate) {
            queue.push(options);
        }
        // Si pas d'affichage en cours, traiter
        if (!isShowing) {
            processQueue();
        }
    }

    // P2-26 : Toast comme fallback au lieu de alert
    function processQueue() {
        if (queue.length === 0) return;
        if (isShowing) return;
        const next = queue.shift();
        try {
            renderModal(next);
        } catch (e) {
            // P2-26 : Utiliser un toast au lieu d'alert
            fallbackUsed = true;
            console.error('[ErrorManager] Échec du modal, fallback toast:', e);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast(next.message || 'Erreur système', 'error');
            } else {
                // Fallback ultime si UI n'est pas disponible
                console.error('[ErrorManager] UI non disponible, affichage dans la console:', next.message);
                // On ne fait pas d'alert pour ne pas bloquer l'utilisateur
            }
            isShowing = false;
            processQueue();
        }
    }

    // --- API publique ---
    function show(options) {
        // Normalisation des options
        const opts = {
            type: options.type || 'error',
            title: options.title || 'Erreur',
            message: options.message || 'Une erreur est survenue.',
            details: options.details || null,
            code: options.code || CONFIG.defaultCode,
            // Pour le diagnostic
            _originalError: options._originalError || null,
            _timestamp: new Date().toISOString()
        };

        // Journalisation technique (console)
        if (opts._originalError) {
            console.error('[ErrorManager] Erreur capturée:', opts._originalError);
        } else {
            console.error('[ErrorManager] Erreur:', opts.message);
        }

        // Si le modal est déjà affiché, mettre en file d'attente
        if (isShowing) {
            enqueue(opts);
            return;
        }

        // Sinon afficher directement
        try {
            renderModal(opts);
        } catch (e) {
            fallbackUsed = true;
            console.error('[ErrorManager] Échec du modal, fallback toast:', e);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast(opts.message || 'Erreur système', 'error');
            } else {
                console.error('[ErrorManager] UI non disponible, erreur:', opts.message);
            }
        }
    }

    // --- Initialisation du gestionnaire ---
    function init() {
        createModal();
        // S'assurer que le modal est caché au départ
        if (modalElement) modalElement.style.display = 'none';
        isShowing = false;
        console.log('[ErrorManager] Initialisé');
    }

    // --- Exposer l'API ---
    return {
        // Version du gestionnaire d'erreurs (cycle de vie indépendant)
        VERSION: '1.0.0',
        show: show,
        hide: hide,
        init: init,
        // Pour les tests
        _getQueue: () => queue,
        _reset: () => { queue = []; isShowing = false; }
    };
})();

// Initialisation automatique au chargement du DOM
document.addEventListener('DOMContentLoaded', function() {
    ErrorManager.init();
});

// Exposer globalement
window.ErrorManager = ErrorManager;