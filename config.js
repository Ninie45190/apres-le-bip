/* Projet Supabase « apres-le-bip » (clé publique : sans danger dans le code du site) */
const CFG = {
  url: 'https://vvdrkshywvolajjblxrg.supabase.co',
  key: 'sb_publishable_2G0JoQ1tdpPmY63YukloJQ_eNBA8KNS',
  maxVideoMB: 50,   // doit correspondre à la limite du serveur (offre gratuite Supabase : 50 Mo par fichier)
  maxPhotoMB: 15,
  // Documents juridiques : renseigner cgvUrl: 'cgv.html' une fois les conditions de vente publiées (affiche le lien et la case de renonciation à la rétractation)
  legal: { cgvUrl: '' },
  // Boutique : laissez vide ce qui n'est pas encore prêt (le bouton correspondant n'apparaît pas)
  shop: {
    etsyUrl: '',            // adresse de votre annonce Etsy
    payUrlStandard: '',     // lien de paiement en ligne (formule essentielle)
    payUrlCapsule: '',      // lien de paiement en ligne (formule avec time capsule)
    priceStandard: '29,90 €',                                  // prix affiché (formule essentielle)
    priceStandardNote: 'Prix de lancement · puis 39,90 €',     // petite mention sous le prix (laisser vide si inutile)
    priceCapsule: '49,90 €',                                   // prix affiché (formule avec time capsule)
    priceCapsuleNote: 'Prix de lancement · puis 59,90 €'
  }
};
