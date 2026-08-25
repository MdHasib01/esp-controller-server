const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const devicesController = require('../controllers/devices.controller');

const router = Router();
router.use(requireAuth);

router.get('/', devicesController.list);
router.post('/', devicesController.create);
router.get('/:id', devicesController.getOne);
router.patch('/:id', devicesController.update);

router.post('/:id/wake', devicesController.wake);
router.post('/:id/checkup/start', devicesController.startCheckup);
router.post('/:id/checkup/end', devicesController.endCheckup);

router.get('/:id/events', devicesController.events);
router.get('/:id/stats', devicesController.stats);

module.exports = router;
